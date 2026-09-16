import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  desktopAssetName,
  fileHash,
  prepareNativeInputs,
  importInputs,
  inventory,
  jobPlan,
  targets,
  signing,
  verifyCollected,
  verifyJob,
} from "./local-build.mjs";

export const version = "0.0.41-nightly.20260916.1780.mzs.r123456abcdef";
export function releaseFixture(t) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-release-test-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const fleet = {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    sourceSha: "b".repeat(40),
    controlsSha: "a".repeat(40),
    base: { tag: "v0.0.41-nightly.20260916.1780", sha: "c".repeat(40) },
    overlays: [],
    toolchain: { node: process.versions.node, vp: "0.3.1", rust: "1.93.0", seaNode: "26.8.2" },
  };
  const plan = {
    schemaVersion: 1,
    identity: NodeCrypto.createHash("sha256")
      .update(JSON.stringify({ fleet, nativeInputs: null }))
      .digest("hex"),
    sourceTree: "d".repeat(40),
    lockfileSha256: "e".repeat(64),
    fleet,
    targets,
    signing,
  };
  NodeFS.writeFileSync(NodePath.join(directory, "mzs-fleet.json"), JSON.stringify(fleet));
  const receipts = targets.map((target) => {
    const [platform, arch] = target.split("-");
    const job = jobPlan("", directory, plan, platform, arch);
    const feed = {
      "mac-arm64": "nightly-mac.yml",
      "mac-x64": "nightly-mac-x64.yml",
      "linux-x64": "nightly-linux.yml",
      "linux-arm64": "nightly-linux-arm64.yml",
      "win-x64": "nightly-win-x64.yml",
      "win-arm64": "nightly-win-arm64.yml",
    }[target];
    NodeFS.mkdirSync(job.artifacts, { recursive: true });
    for (const name of [
      desktopAssetName(platform, arch, version),
      feed,
      ...(job.archive ? [job.archive] : []),
    ])
      NodeFS.writeFileSync(NodePath.join(job.artifacts, name), `asset ${name}`);
    const receipt = {
      schemaVersion: 1,
      identity: plan.identity,
      sourceTree: plan.sourceTree,
      lockfileSha256: plan.lockfileSha256,
      target,
      host: "linux-x64",
      signing: signing[platform],
      smoke: { status: "not-run", reason: "Fixture" },
      assets: inventory(job.artifacts),
    };
    NodeFS.writeFileSync(
      NodePath.join(directory, "jobs", target, "receipt.json"),
      JSON.stringify(receipt),
    );
    return receipt;
  });
  return { directory, fleet, plan, receipts };
}
export function collectedFixture(t) {
  const fixture = releaseFixture(t);
  const directory = NodePath.join(fixture.directory, "artifacts");
  NodeFS.mkdirSync(directory);
  for (const receipt of fixture.receipts)
    for (const asset of receipt.assets)
      NodeFS.copyFileSync(
        NodePath.join(fixture.directory, "jobs", receipt.target, "assets", asset.name),
        NodePath.join(directory, asset.name),
      );
  NodeFS.copyFileSync(
    NodePath.join(fixture.directory, "mzs-fleet.json"),
    NodePath.join(directory, "mzs-fleet.json"),
  );
  NodeFS.writeFileSync(NodePath.join(directory, "nightly.yml"), "merged windows manifest");
  NodeFS.writeFileSync(NodePath.join(directory, "release-notes.md"), "release notes\n");
  NodeFS.writeFileSync(NodePath.join(directory, `t3-source-${version}.bundle`), "source bundle");
  NodeFS.writeFileSync(
    NodePath.join(directory, "build-provenance.json"),
    JSON.stringify({
      plan: fixture.plan,
      receipts: fixture.receipts,
      assets: inventory(directory),
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "SHA256SUMS"),
    inventory(directory)
      .map((asset) => `${asset.sha256}  ${asset.name}\n`)
      .join(""),
  );
  return { ...fixture, release: directory };
}

NodeTest.test(
  "all local jobs use exact cross targets, native smoke and Windows WSL archives",
  (t) => {
    const { plan } = releaseFixture(t);
    for (const target of targets) {
      const [platform, arch] = target.split("-");
      const job = jobPlan("/source", "/release", plan, platform, arch);
      NodeAssert.equal(job.commands[0][0], "vp");
      NodeAssert.deepEqual(job.commands[0][1], ["i", "--frozen-lockfile", "--ignore-scripts"]);
      const executable = job.commands.find(([, args]) => args.includes("build-exe"));
      NodeAssert.equal(Boolean(executable), target !== "mac-x64");
      if (executable)
        NodeAssert.ok(
          executable[1].includes(`${platform === "mac" ? "darwin" : platform}-${arch}`),
        );
      if (platform === "win")
        NodeAssert.ok(
          job.commands[2][1].includes(
            `/release/jobs/linux-${arch}/assets/t3-${version}-linux-${arch}.tar.gz`,
          ),
        );
      if (platform === "mac") NodeAssert.ok(job.commands[2][1].includes("zip"));
    }
  },
);
NodeTest.test("resumes only matching receipts and untouched asset bytes", (t) => {
  const f = releaseFixture(t);
  NodeAssert.equal(verifyJob(f.directory, f.plan, "linux", "x64").target, "linux-x64");
  NodeFS.writeFileSync(
    NodePath.join(f.directory, "jobs/linux-x64/assets", `t3-${version}-linux-x64.tar.gz`),
    "damaged",
  );
  NodeAssert.throws(() => verifyJob(f.directory, f.plan, "linux", "x64"), /Changed assets/);
});
NodeTest.test(
  "collect verification refuses missing architectures, changed metadata and incomplete checksums",
  (t) => {
    const f = collectedFixture(t);
    NodeAssert.equal(verifyCollected(f.release).plan.identity, f.plan.identity);
    NodeFS.appendFileSync(NodePath.join(f.release, "SHA256SUMS"), "unexpected\n");
    NodeAssert.throws(() => verifyCollected(f.release), /Checksums/);
    const provenance = JSON.parse(
      NodeFS.readFileSync(NodePath.join(f.release, "build-provenance.json")),
    );
    provenance.receipts.pop();
    NodeFS.writeFileSync(
      NodePath.join(f.release, "build-provenance.json"),
      JSON.stringify(provenance),
    );
    NodeAssert.throws(() => verifyCollected(f.release), /provenance/);
  },
);
NodeTest.test("a cross-built receipt must state why smoke was not run", (t) => {
  const f = releaseFixture(t);
  const receipt = f.receipts[0];
  delete receipt.smoke.reason;
  NodeFS.writeFileSync(
    NodePath.join(f.directory, "jobs/linux-x64/receipt.json"),
    JSON.stringify(receipt),
  );
  NodeAssert.throws(() => verifyJob(f.directory, f.plan, "linux", "x64"), /Incompatible receipt/);
});
NodeTest.test("dry-run plans need no dependencies and reject dirty pinned source", (t) => {
  const f = releaseFixture(t);
  const source = NodePath.join(f.directory, "source");
  NodeFS.mkdirSync(source);
  const files = {
    "apps/server/package.json": JSON.stringify({ version }),
    "apps/desktop/package.json": JSON.stringify({ version }),
    "apps/web/package.json": JSON.stringify({ version }),
    "apps/server/vite.config.ts": 'const SEA_NODE_VERSION = "26.8.2";',
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(source, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(source, name), bytes);
  }
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=NodeTest",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  f.fleet.sourceSha = git("rev-parse", "HEAD");
  NodeFS.writeFileSync(NodePath.join(f.directory, "mzs-fleet.json"), JSON.stringify(f.fleet));
  const args = [
    new URL("./local-build.mjs", import.meta.url).pathname,
    source,
    f.directory,
    version,
    "win",
    "x64",
    "--dry-run",
  ];
  const result = NodeChildProcess.spawnSync(process.execPath, args, { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(JSON.parse(result.stdout).result, "plan");
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.directory, "build-plan.json")), false);
  NodeFS.appendFileSync(NodePath.join(source, "pnpm-lock.yaml"), "dirty");
  NodeAssert.match(
    NodeChildProcess.spawnSync(process.execPath, args, { encoding: "utf8" }).stderr,
    /clean, version-stamped/,
  );
});

NodeTest.test("local CLI builds once, reuses verified outputs and rejects a damaged retry", (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-build-execution-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const root = NodePath.join(directory, "source");
  const release = NodePath.join(directory, "release");
  const tools = NodePath.join(directory, "tools");
  NodeFS.mkdirSync(release);
  NodeFS.mkdirSync(tools);
  const files = {
    "package.json": '{"type":"module"}',
    ".gitignore": "dist/\ndist-electron/\ndist-exe/\ntarget/\n",
    "apps/server/package.json": JSON.stringify({ version }),
    "apps/desktop/package.json": JSON.stringify({ version }),
    "apps/web/package.json": JSON.stringify({ version }),
    "apps/server/vite.config.ts": 'const SEA_NODE_VERSION = "26.8.2";',
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    ".mzs/local-build.mjs": NodeFS.readFileSync(
      new URL("./local-build.mjs", import.meta.url),
      "utf8",
    ),
    "apps/server/scripts/cli.ts": "process.exit(0);",
    "scripts/build-desktop-artifact.ts": `import * as fs from "node:fs"; import * as path from "node:path";
      const args = process.argv; const out = args[args.indexOf('--output-dir') + 1];
      const arch = args[args.indexOf('--arch') + 1]; const mac = args[args.indexOf('--platform') + 1] === 'mac';
      for (const name of mac ? ['T3-Code-${version}-'+arch+'.zip','nightly-mac.yml'] : ['T3-Code-${version}-'+(arch === 'x64' ? 'x86_64' : arch)+'.AppImage','nightly-linux.yml']) fs.writeFileSync(path.join(out,name), name);
      fs.writeFileSync('apps/server/dist/bundle.js','nightly branding');
      const monitor = 'native/resource-monitor/target/'+(arch === 'arm64' ? 'aarch64' : 'x86_64')+(mac ? '-apple-darwin' : '-unknown-linux-gnu')+'/release'; fs.mkdirSync(monitor, {recursive:true}); fs.writeFileSync(path.join(monitor, 't3-resource-monitor'),'monitor');`,
    "scripts/build-cli-archive.ts": `import * as fs from "node:fs"; import * as path from "node:path";
      const args = process.argv; const out = args[args.indexOf('--output-dir') + 1]; const platform = args[args.indexOf('--platform') + 1];
      const arch = args[args.indexOf('--arch') + 1]; fs.writeFileSync(path.join(out, 't3-${version}-'+(platform === 'mac' ? 'darwin' : platform)+'-'+arch+'.tar.gz'), 'archive');`,
    "scripts/smoke-cli-archive.ts": "process.exit(0);",
  };
  for (const [name, bytes] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, name), bytes);
  }
  for (const [name, source] of Object.entries({
    vp: `if(process.argv.includes('--version')) { console.log('vp v0.3.1'); } else {
      const fs = require('node:fs'); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({args:process.argv.slice(2),node:process.env.VP_NODE_VERSION})+'\\n');
      if(process.argv.includes('build:desktop')) for(const dir of ['apps/server/dist','apps/desktop/dist-electron']) {
        fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(dir+'/bundle.js','bundle');
      }
    }`,
    rustc: "console.log('rustc 1.93.0 fixture');",
  }))
    NodeFS.writeFileSync(NodePath.join(tools, name), `#!${process.execPath}\n${source}`, {
      mode: 0o755,
    });
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=NodeTest",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  const fleet = {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    sourceSha: commit,
    controlsSha: commit,
    base: { tag: "base", sha: commit },
    overlays: [],
    toolchain: { node: process.versions.node, vp: "0.3.1", rust: "1.93.0", seaNode: "26.8.2" },
  };
  NodeFS.writeFileSync(NodePath.join(release, "mzs-fleet.json"), JSON.stringify(fleet));
  const log = NodePath.join(directory, "commands.jsonl");
  const run = (platform = "linux", arch = "x64") =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, ".mzs/local-build.mjs"), root, release, version, platform, arch],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tools}${NodePath.delimiter}${process.env.PATH}`,
          COMMAND_LOG: log,
        },
      },
    );
  let result = run();
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(JSON.parse(result.stdout).result, "built");
  const commands = NodeFS.readFileSync(log, "utf8");
  NodeAssert.equal(
    JSON.parse(NodeFS.readFileSync(NodePath.join(release, "jobs/linux-x64/receipt.json"))).smoke
      .status,
    "passed",
  );
  const smokeCommand = commands
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.args.includes("scripts/smoke-cli-archive.ts"));
  NodeAssert.equal(smokeCommand.node, "26.8.2");
  result = run();
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(JSON.parse(result.stdout).result, "reused");
  NodeAssert.equal(NodeFS.readFileSync(log, "utf8"), commands);
  result = run("mac", "arm64");
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(JSON.parse(result.stdout).result, "built");
  NodeAssert.equal(
    JSON.parse(NodeFS.readFileSync(NodePath.join(release, "jobs/mac-arm64/receipt.json"))).smoke
      .status,
    "not-run",
  );
  NodeAssert.equal(NodeFS.readFileSync(log, "utf8").split("build:desktop").length - 1, 1);
  const afterCrossBuild = NodeFS.readFileSync(log, "utf8");
  NodeFS.appendFileSync(
    NodePath.join(release, "jobs/linux-x64/assets", `t3-${version}-linux-x64.tar.gz`),
    "damaged",
  );
  NodeAssert.match(run().stderr, /Changed assets/);
  NodeAssert.equal(NodeFS.readFileSync(log, "utf8"), afterCrossBuild);
});

NodeTest.test(
  "native helper reuse verifies source trees and bytes before writing build outputs",
  (t) => {
    const f = releaseFixture(t);
    const source = NodePath.join(f.directory, "source");
    NodeFS.mkdirSync(NodePath.join(source, "native/resource-monitor"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(source, "native/resource-monitor/source.rs"),
      "fn main() {}\n",
    );
    NodeFS.writeFileSync(NodePath.join(source, ".gitignore"), "target/\n");
    for (const workspace of ["server", "desktop", "web"]) {
      NodeFS.mkdirSync(NodePath.join(source, "apps", workspace), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(source, "apps", workspace, "package.json"),
        JSON.stringify({ version }),
      );
    }
    NodeFS.writeFileSync(
      NodePath.join(source, "apps/server/vite.config.ts"),
      'const SEA_NODE_VERSION = "26.8.2";',
    );
    const git = (...args) =>
      NodeChildProcess.execFileSync("git", ["-C", source, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=NodeTest",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    f.fleet.sourceSha = git("rev-parse", "HEAD");
    const helper = NodePath.join(f.directory, "helper");
    NodeFS.writeFileSync(helper, "verified binary");
    const destination =
      "native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor";
    const input = {
      files: [
        {
          path: "helper",
          sha256: fileHash(helper),
          source: "native/resource-monitor",
          sourceTree: git("rev-parse", "HEAD:native/resource-monitor"),
          destination,
        },
      ],
      env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
      tools: [],
    };
    f.plan.nativeInputs = { schemaVersion: 1, targets: { "mac-arm64": input } };
    let env = prepareNativeInputs(source, f.directory, f.plan, "mac-arm64", {
      PATH: process.env.PATH,
    });
    NodeAssert.equal(env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR, "true");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(source, destination), "utf8"),
      "verified binary",
    );
    NodeFS.writeFileSync(
      NodePath.join(f.directory, "native-inputs.json"),
      JSON.stringify(f.plan.nativeInputs),
    );
    const imported = NodePath.join(f.directory, "imported");
    NodeFS.mkdirSync(imported);
    NodeFS.writeFileSync(NodePath.join(imported, "mzs-fleet.json"), JSON.stringify(f.fleet));
    NodeAssert.equal(importInputs(source, imported, f.directory).files, 1);
    NodeAssert.equal(importInputs(source, imported, f.directory).result, "imported");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(imported, "helper"), "utf8"),
      "verified binary",
    );
    NodeFS.writeFileSync(helper, "changed binary");
    NodeAssert.throws(() => importInputs(source, imported, f.directory), /does not match source/);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(imported, "helper"), "utf8"),
      "verified binary",
    );
    NodeAssert.throws(
      () => prepareNativeInputs(source, f.directory, f.plan, "mac-arm64", env),
      /does not match source/,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(source, destination), "utf8"),
      "verified binary",
    );
    NodeFS.writeFileSync(helper, "verified binary");
    input.files[0].sourceTree = "f".repeat(40);
    NodeAssert.throws(
      () => prepareNativeInputs(source, f.directory, f.plan, "mac-arm64", env),
      /does not match source/,
    );
  },
);

NodeTest.test("builder debug configuration stays out of the published inventory", (t) => {
  const f = collectedFixture(t);
  const file = NodePath.join(f.release, "build-provenance.json");
  const provenance = JSON.parse(NodeFS.readFileSync(file));
  provenance.receipts[0].assets.push({
    name: "builder-effective-config.yaml",
    size: 9,
    sha256: "a".repeat(64),
  });
  NodeFS.writeFileSync(file, JSON.stringify(provenance));
  NodeFS.writeFileSync(
    NodePath.join(f.release, "SHA256SUMS"),
    inventory(f.release)
      .filter((asset) => asset.name !== "SHA256SUMS")
      .map((asset) => `${asset.sha256}  ${asset.name}\n`)
      .join(""),
  );
  NodeAssert.equal(verifyCollected(f.release).plan.identity, f.plan.identity);
});
