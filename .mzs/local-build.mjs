import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";

export const targets = ["linux-x64", "linux-arm64", "mac-arm64", "mac-x64", "win-x64", "win-arm64"];
export const signing = { mac: "ad-hoc", linux: "unsigned", win: "unsigned" };
const releaseAsset = (name) =>
  !name.startsWith("builder-debug") && !name.startsWith("builder-effective-config");
const sha = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const controlsRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const capture = (command, args, cwd) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
const git = (root, ...args) => capture("git", ["-C", root, ...args]);
export function fileHash(file) {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let length;
    while ((length = NodeFS.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally {
    NodeFS.closeSync(fd);
  }
}
export function inventory(directory) {
  const names = NodeFS.readdirSync(directory).sort();
  if (!names.length || names.length > 100) throw new Error("Invalid asset count");
  return names.map((name) => {
    const file = NodePath.join(directory, name);
    const stat = NodeFS.lstatSync(file);
    if (!/^[\w.-]+$/.test(name) || !stat.isFile() || stat.size < 1)
      throw new Error(`Invalid asset: ${name}`);
    return { name, size: stat.size, sha256: fileHash(file) };
  });
}
export function readFleet(directory, version) {
  const fleet = readJson(NodePath.join(directory, "mzs-fleet.json"));
  if (
    fleet.schemaVersion !== 1 ||
    fleet.version !== version ||
    fleet.releaseTag !== `v${version}` ||
    !/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.mzs\.r[a-f0-9]{12}$/.test(version) ||
    ![fleet.sourceSha, fleet.controlsSha, fleet.base?.sha].every((value) =>
      /^[a-f0-9]{40}$/.test(value ?? ""),
    ) ||
    !Array.isArray(fleet.overlays) ||
    !["node", "vp", "rust", "seaNode"].every((name) =>
      /^\d+\.\d+\.\d+$/.test(fleet.toolchain?.[name] ?? ""),
    )
  )
    throw new Error("Invalid pinned fleet metadata");
  return fleet;
}
export function assertSource(root, fleet) {
  if (
    git(root, "rev-parse", "HEAD") !== fleet.sourceSha ||
    git(root, "status", "--porcelain", "--untracked-files=normal")
  )
    throw new Error("Source must match the clean, version-stamped sourceSha");
  for (const workspace of ["server", "desktop", "web"])
    if (readJson(NodePath.join(root, `apps/${workspace}/package.json`)).version !== fleet.version)
      throw new Error(`Version-stamp apps/${workspace} before building`);
  if (
    [".env", ".env.local", ".env.production", ".env.production.local"].some((name) =>
      NodeFS.existsSync(NodePath.join(root, name)),
    )
  )
    throw new Error(
      "Remove untracked env files from the isolated build source; build inputs must be pinned",
    );
  const config = NodeFS.readFileSync(NodePath.join(root, "apps/server/vite.config.ts"), "utf8");
  if (!config.includes(`const SEA_NODE_VERSION = "${fleet.toolchain.seaNode}"`))
    throw new Error("SEA Node pin does not match source");
}
export function releasePlan(root, fleet, directory) {
  const inputsPath = NodePath.join(directory, "native-inputs.json");
  const nativeInputs = NodeFS.existsSync(inputsPath) ? readJson(inputsPath) : null;
  if (
    nativeInputs &&
    (nativeInputs.schemaVersion !== 1 ||
      !nativeInputs.targets ||
      Object.keys(nativeInputs.targets).some((target) => !targets.includes(target)))
  )
    throw new Error("Invalid native inputs");
  return {
    schemaVersion: 1,
    identity: sha(JSON.stringify({ fleet, nativeInputs })),
    nativeInputs,
    sourceTree: git(root, "rev-parse", "HEAD^{tree}"),
    lockfileSha256: fileHash(NodePath.join(root, "pnpm-lock.yaml")),
    fleet,
    targets,
    signing,
    unsupported: [
      {
        target: "mac-x64",
        artifact: "cli",
        reason: "Pinned Node SEA runtime does not support darwin-x64",
      },
    ],
  };
}
export function jobPlan(root, directory, plan, platform, arch) {
  const target = `${platform}-${arch}`;
  if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}`);
  const version = plan.fleet.version;
  const artifacts = NodePath.join(directory, "jobs", target, "assets");
  const nodePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform;
  const archive =
    platform === "mac" && arch === "x64"
      ? null
      : `t3-${version}-${nodePlatform}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`;
  const desktopTarget = { mac: "zip", linux: "AppImage", win: "nsis" }[platform];
  const commands = [
    ["vp", ["i", "--frozen-lockfile", "--ignore-scripts"]],
    ["vp", ["run", "build:desktop"]],
    [
      process.execPath,
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        platform,
        "--target",
        desktopTarget,
        "--arch",
        arch,
        "--build-version",
        version,
        "--output-dir",
        artifacts,
        "--skip-build",
        "--verbose",
        ...(platform === "win"
          ? [
              "--wsl-runtime",
              NodePath.join(
                directory,
                "jobs",
                `linux-${arch}`,
                "assets",
                `t3-${version}-linux-${arch}.tar.gz`,
              ),
            ]
          : []),
      ],
    ],
  ];
  if (archive)
    commands.push(
      [
        process.execPath,
        [
          "apps/server/scripts/cli.ts",
          "build-exe",
          "--target",
          `${platform === "mac" ? "darwin" : platform}-${arch}`,
          "--verbose",
        ],
      ],
      [
        process.execPath,
        [
          "scripts/build-cli-archive.ts",
          "--platform",
          platform,
          "--arch",
          arch,
          "--version",
          version,
          "--output-dir",
          artifacts,
          "--resource-monitor-dir",
          plan.nativeInputs?.targets[target]?.resourceMonitorDir
            ? inputPath(directory, plan.nativeInputs.targets[target].resourceMonitorDir)
            : NodePath.join(directory, "jobs", target, "resource-monitor"),
        ],
      ],
    );
  const native = NodeProcess.platform === nodePlatform && NodeProcess.arch === arch;
  if (archive && native)
    commands.push([
      "vp",
      [
        "exec",
        "node",
        "scripts/smoke-cli-archive.ts",
        "--archive",
        NodePath.join(artifacts, archive),
        "--expect-version",
        version,
      ],
    ]);
  return {
    target,
    platform,
    arch,
    archive,
    artifacts,
    commands,
    host: `${NodeProcess.platform}-${NodeProcess.arch}`,
    smoke:
      archive && native
        ? { status: "pending" }
        : {
            status: "not-run",
            reason: archive
              ? "Target cannot execute on this build host"
              : "CLI archive unsupported for this target",
          },
  };
}
function requireAssets(job, assets, version) {
  const required = job.archive ? [job.archive] : [];
  for (const extension of { mac: ["zip"], linux: ["AppImage"], win: ["exe"] }[job.platform])
    required.push(`T3-Code-${version}-${job.arch}.${extension}`);
  for (const name of required)
    if (!assets.some((asset) => asset.name === name))
      throw new Error(`Missing ${job.target} artifact: ${name}`);
  const feed =
    job.platform === "mac"
      ? `nightly-mac${job.arch === "x64" ? "-x64" : ""}.yml`
      : job.platform === "win"
        ? `nightly-win-${job.arch}.yml`
        : `nightly-linux${job.arch === "arm64" ? "-arm64" : ""}.yml`;
  if (!assets.some((asset) => asset.name === feed))
    throw new Error(`Missing ${job.target} updater manifest: ${feed}`);
}
export function verifyJob(directory, plan, platform, arch) {
  const target = `${platform}-${arch}`;
  const job = jobPlan("", directory, plan, platform, arch);
  const receipt = readJson(NodePath.join(directory, "jobs", target, "receipt.json"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.identity !== plan.identity ||
    receipt.target !== target ||
    receipt.sourceTree !== plan.sourceTree ||
    receipt.lockfileSha256 !== plan.lockfileSha256 ||
    !["passed", "not-run"].includes(receipt.smoke?.status) ||
    (receipt.smoke.status === "not-run" && !receipt.smoke.reason) ||
    receipt.signing !== signing[receipt.target.split("-")[0]]
  )
    throw new Error(`Incompatible receipt: ${target}`);
  const assets = inventory(job.artifacts);
  if (JSON.stringify(assets) !== JSON.stringify(receipt.assets))
    throw new Error(`Changed assets: ${target}`);
  requireAssets(job, assets, plan.fleet.version);
  return receipt;
}
function inputPath(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    NodePath.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw new Error("Native input paths must be relative and stay within their root");
  return NodePath.join(root, relative);
}
function validateNativeInputs(root, directory, plan, target) {
  const inputs = plan.nativeInputs?.targets[target];
  if (!inputs) return { inputs: null, configured: {} };
  if (!Array.isArray(inputs.files) || inputs.files.length > 100 || (inputs.tools?.length ?? 0) > 20)
    throw new Error("Invalid native input inventory");
  for (const file of inputs.files) {
    const path = inputPath(directory, file.path);
    if (
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      fileHash(path) !== file.sha256 ||
      !/^[a-f0-9]{40}$/.test(file.sourceTree) ||
      !file.source?.startsWith("native/") ||
      git(root, "rev-parse", `HEAD:${file.source}`) !== file.sourceTree
    )
      throw new Error(`Native input does not match source: ${file.path}`);
  }
  for (const tool of inputs.tools ?? [])
    if (
      !tool.version ||
      !/^[a-f0-9]{64}$/.test(tool.sha256) ||
      fileHash(inputPath(directory, tool.path)) !== tool.sha256
    )
      throw new Error(`Native tool pin mismatch: ${tool.path}`);
  const allowed = new Set([
    "T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
    "T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS",
    "T3CODE_DESKTOP_BROWSER_SECRET",
    "T3CODE_DESKTOP_BROWSER_SECRET_SHA256",
    "USE_SYSTEM_WINE",
  ]);
  const configured = {};
  for (const [name, value] of Object.entries(inputs.env ?? {})) {
    if (!allowed.has(name) || typeof value !== "string")
      throw new Error(`Unsupported native environment: ${name}`);
    configured[name] = value.replaceAll("$RELEASE_DIR", directory);
  }
  const [platform, arch] = target.split("-");
  const triple = {
    mac: `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
    linux: `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`,
    win: `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`,
  }[platform];
  const reused = [];
  if (configured.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR === "true")
    reused.push(["resource-monitor", `t3-resource-monitor${platform === "win" ? ".exe" : ""}`]);
  if (configured.T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS === "true")
    reused.push(
      ["kde-snap-shot", "t3-kde-snap-shot"],
      ["hyprland-snap-shot", "t3-hyprland-snap-shot"],
    );
  for (const [module, binary] of reused)
    if (
      !inputs.files.some(
        (file) =>
          file.source === `native/${module}` &&
          file.destination === `native/${module}/target/${triple}/release/${binary}`,
      )
    )
      throw new Error(`Missing pinned reused helper: ${module}`);
  if (
    configured.T3CODE_DESKTOP_BROWSER_SECRET &&
    !inputs.files.some(
      (file) =>
        file.source === "native/browser-secret" &&
        inputPath(directory, file.path) === configured.T3CODE_DESKTOP_BROWSER_SECRET &&
        file.sha256 === configured.T3CODE_DESKTOP_BROWSER_SECRET_SHA256,
    )
  )
    throw new Error("Browser secret helper must match its pinned file");
  if (configured.USE_SYSTEM_WINE && !plan.fleet.toolchain.containerImage)
    throw new Error("System Wine requires a pinned build container");
  if (inputs.resourceMonitorDir) {
    const monitorRoot = inputPath(directory, inputs.resourceMonitorDir);
    const files = NodeFS.readdirSync(monitorRoot, { recursive: true, withFileTypes: true }).filter(
      (entry) => !entry.isDirectory(),
    );
    if (!files.length || files.length > 20) throw new Error("Invalid resource monitor inventory");
    for (const entry of files) {
      const filePath = NodePath.join(entry.parentPath, entry.name);
      if (
        !entry.isFile() ||
        !inputs.files.some(
          (file) =>
            file.source === "native/resource-monitor" &&
            inputPath(directory, file.path) === filePath,
        )
      )
        throw new Error(`Unpinned resource monitor file: ${entry.name}`);
    }
  }
  return { inputs, configured };
}
export function prepareNativeInputs(root, directory, plan, target, env) {
  const { inputs, configured } = validateNativeInputs(root, directory, plan, target);
  if (!inputs) return env;
  for (const file of inputs.files) {
    if (!file.destination) continue;
    const destination = inputPath(root, file.destination);
    if (!file.destination.startsWith("native/") || !file.destination.includes("/target/"))
      throw new Error("Native destinations must be ignored target build outputs");
    git(root, "check-ignore", "--quiet", file.destination);
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.copyFileSync(inputPath(directory, file.path), destination);
    NodeFS.chmodSync(destination, 0o755);
  }
  if (!inputs.tools?.length) return { ...env, ...configured };
  const toolBin = NodeFS.mkdtempSync(NodePath.join(directory, "jobs", `${target}-tools-`));
  for (const tool of inputs.tools ?? []) {
    const path = inputPath(directory, tool.path);
    const destination = NodePath.join(toolBin, NodePath.basename(path));
    NodeFS.copyFileSync(path, destination, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(destination, 0o755);
  }
  return {
    ...env,
    ...configured,
    PATH: [toolBin, env.PATH].join(NodePath.delimiter),
    FLEET_TEMP_TOOL_BIN: toolBin,
  };
}
export function importInputs(root, directory, kit) {
  const fleet = readJson(NodePath.join(directory, "mzs-fleet.json"));
  readFleet(directory, fleet.version);
  assertSource(root, fleet);
  const nativeInputs = readJson(NodePath.join(kit, "native-inputs.json"));
  if (
    nativeInputs.schemaVersion !== 1 ||
    !nativeInputs.targets ||
    Object.keys(nativeInputs.targets).some((target) => !targets.includes(target))
  )
    throw new Error("Invalid build kit target inventory");
  const plan = { fleet, nativeInputs };
  for (const target of Object.keys(nativeInputs.targets))
    validateNativeInputs(root, kit, plan, target);
  const manifest = NodePath.join(directory, "native-inputs.json");
  if (
    NodeFS.existsSync(manifest) &&
    JSON.stringify(readJson(manifest)) !== JSON.stringify(nativeInputs)
  )
    throw new Error("Release directory already contains different native inputs");
  const copies = new Map();
  for (const inputs of Object.values(nativeInputs.targets))
    for (const file of [...inputs.files, ...(inputs.tools ?? [])]) {
      if (copies.has(file.path) && copies.get(file.path) !== file.sha256)
        throw new Error(`Conflicting build kit input: ${file.path}`);
      copies.set(file.path, file.sha256);
    }
  for (const [relative, checksum] of copies) {
    const destination = inputPath(directory, relative);
    if (NodeFS.existsSync(destination)) {
      if (fileHash(destination) !== checksum)
        throw new Error(`Changed imported input: ${relative}`);
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.copyFileSync(inputPath(kit, relative), destination, NodeFS.constants.COPYFILE_EXCL);
    if (fileHash(destination) !== checksum)
      throw new Error(`Build kit changed during copy: ${relative}`);
  }
  writeJson(manifest, nativeInputs);
  return {
    result: "imported",
    targets: Object.keys(nativeInputs.targets),
    files: copies.size,
    manifest,
  };
}
function jsInventory(root) {
  const files = [];
  const visit = (relative) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = `${relative}/${entry.name}`;
      if (entry.name === "resource-monitor") continue;
      if (files.length > 20000) throw new Error("JS build inventory exceeds limit");
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push({ name, sha256: fileHash(NodePath.join(root, name)) });
      else throw new Error(`Unexpected JS build entry: ${name}`);
    }
  };
  for (const directory of ["apps/server/dist", "apps/desktop/dist-electron"]) visit(directory);
  return files.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
function execute(command, args, root, env) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", 2, 2],
    timeout: 60 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${NodePath.basename(command)} failed: ${result.signal ?? result.status}`);
}
function buildEnvironment(fleet) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:T3CODE_|VITE_|EXPO_PUBLIC_|CSC_|APPLE_|AZURE_|MACOS_PROVISIONING_PROFILE|GITHUB_REPOSITORY|ELECTRON_BUILDER_WINE_TOOLSET_DIR|LD_LIBRARY_PATH|USE_SYSTEM_WINE)/.test(
          name,
        ),
    ),
  );
  return {
    ...env,
    VITE_MZS_FLEET_LABEL: "MZS Fleet",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "msegec/t3code_rookie",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    VP_NODE_VERSION: fleet.toolchain.node,
  };
}
export function build(root, directory, version, platform, arch, dryRun = false) {
  const fleet = readFleet(directory, version);
  assertSource(root, fleet);
  const plan = releasePlan(root, fleet, directory);
  const job = jobPlan(root, directory, plan, platform, arch);
  if (dryRun) return { result: "plan", plan, job };
  if (
    git(controlsRoot, "rev-parse", "HEAD") !== fleet.controlsSha ||
    git(controlsRoot, "status", "--porcelain", "--untracked-files=normal")
  )
    throw new Error("Controls must match the clean pinned controlsSha");
  const planPath = NodePath.join(directory, "build-plan.json");
  if (NodeFS.existsSync(planPath) && JSON.stringify(readJson(planPath)) !== JSON.stringify(plan))
    throw new Error("Release directory belongs to a different build plan");
  const receiptPath = NodePath.join(directory, "jobs", job.target, "receipt.json");
  if (NodeFS.existsSync(receiptPath)) {
    verifyJob(directory, plan, platform, arch);
    return { result: "reused", plan, receiptPath };
  }
  if (
    process.versions.node !== fleet.toolchain.node ||
    capture("vp", ["--version"]).match(/^vp v?(\d+\.\d+\.\d+)/)?.[1] !== fleet.toolchain.vp ||
    capture("rustc", ["--version"]).split(/\s+/)[1] !== fleet.toolchain.rust
  )
    throw new Error("Local toolchain does not match pinned metadata");
  if (
    fleet.toolchain.containerImage &&
    (!/^sha256:[a-f0-9]{64}$/.test(fleet.toolchain.containerImage) ||
      process.env.FLEET_BUILD_IMAGE_ID !== fleet.toolchain.containerImage)
  )
    throw new Error("Build container does not match pinned metadata");
  if (platform === "win") verifyJob(directory, plan, "linux", arch);
  const lockPath = NodePath.resolve(
    root,
    git(root, "rev-parse", "--git-path", "fleet-local-build.lock"),
  );
  NodeFS.mkdirSync(lockPath);
  let env;
  try {
    writeJson(planPath, plan);
    NodeFS.mkdirSync(job.artifacts, { recursive: true });
    if (NodeFS.readdirSync(job.artifacts).length)
      throw new Error(
        `Unverified partial artifacts remain in ${job.artifacts}; preserve them elsewhere before retrying`,
      );
    env = prepareNativeInputs(root, directory, plan, job.target, buildEnvironment(fleet));
    const jsReceipt = NodePath.join(directory, "js-build.json");
    let reuseJs = false;
    if (NodeFS.existsSync(jsReceipt)) {
      const saved = readJson(jsReceipt);
      if (saved.identity === plan.identity && saved.host === job.host) {
        try {
          reuseJs = JSON.stringify(saved.files) === JSON.stringify(jsInventory(root));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    for (const [command, args] of job.commands) {
      if (args.includes("build:desktop") && reuseJs) continue;
      process.stderr.write(`fleet_phase=local_${job.target}_${args[0]}\n`);
      execute(
        command,
        args,
        root,
        args.includes("build-exe") || args.includes("scripts/smoke-cli-archive.ts")
          ? { ...env, VP_NODE_VERSION: fleet.toolchain.seaNode }
          : env,
      );
      if (args[0] === "scripts/build-desktop-artifact.ts") {
        const rawFeed =
          platform === "win"
            ? "nightly.yml"
            : platform === "mac" && arch === "x64"
              ? "nightly-mac.yml"
              : null;
        if (rawFeed) {
          const renamed = platform === "win" ? `nightly-win-${arch}.yml` : "nightly-mac-x64.yml";
          if (NodeFS.existsSync(NodePath.join(job.artifacts, renamed)))
            throw new Error(`Updater manifest already exists: ${renamed}`);
          NodeFS.renameSync(
            NodePath.join(job.artifacts, rawFeed),
            NodePath.join(job.artifacts, renamed),
          );
        }
        if (job.archive && !plan.nativeInputs?.targets[job.target]?.resourceMonitorDir) {
          const triple = {
            mac: `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
            linux: `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`,
            win: `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`,
          }[platform];
          const name = `t3-resource-monitor${platform === "win" ? ".exe" : ""}`;
          const destination = NodePath.join(
            directory,
            "jobs",
            job.target,
            "resource-monitor",
            `${platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform}-${arch}`,
          );
          NodeFS.mkdirSync(destination, { recursive: true });
          NodeFS.copyFileSync(
            NodePath.join(root, "native/resource-monitor/target", triple, "release", name),
            NodePath.join(destination, name),
          );
        }
      }
      if (args.includes("build:desktop")) {
        NodeFS.copyFileSync(
          NodePath.join(directory, "mzs-fleet.json"),
          NodePath.join(root, "apps/server/dist/mzs-fleet.json"),
        );
      }
    }
    assertSource(root, fleet);
    writeJson(jsReceipt, { identity: plan.identity, host: job.host, files: jsInventory(root) });
    const assets = inventory(job.artifacts);
    requireAssets(job, assets, version);
    writeJson(receiptPath, {
      schemaVersion: 1,
      identity: plan.identity,
      target: job.target,
      sourceTree: plan.sourceTree,
      lockfileSha256: plan.lockfileSha256,
      host: job.host,
      signing: signing[job.platform],
      smoke: job.smoke.status === "pending" ? { status: "passed" } : job.smoke,
      assets,
    });
    return { result: "built", plan, receiptPath };
  } finally {
    if (env?.FLEET_TEMP_TOOL_BIN)
      NodeFS.rmSync(env.FLEET_TEMP_TOOL_BIN, { recursive: true, force: true });
    NodeFS.rmdirSync(lockPath);
  }
}
export function verifyCollected(directory) {
  const provenance = readJson(NodePath.join(directory, "build-provenance.json"));
  const { plan, receipts, assets } = provenance;
  const fleet = readFleet(directory, plan?.fleet?.version);
  if (
    plan.schemaVersion !== 1 ||
    plan.identity !== sha(JSON.stringify({ fleet, nativeInputs: plan.nativeInputs ?? null })) ||
    JSON.stringify(plan.fleet) !== JSON.stringify(fleet) ||
    JSON.stringify(plan.targets) !== JSON.stringify(targets) ||
    !Array.isArray(receipts) ||
    receipts.length !== targets.length ||
    new Set(receipts.map((receipt) => receipt.target)).size !== targets.length
  )
    throw new Error("Invalid collected build provenance");
  for (const target of targets) {
    const receipt = receipts.find((entry) => entry.target === target);
    if (
      !receipt ||
      receipt.identity !== plan.identity ||
      receipt.sourceTree !== plan.sourceTree ||
      receipt.lockfileSha256 !== plan.lockfileSha256 ||
      receipt.signing !== signing[receipt.target.split("-")[0]] ||
      !["passed", "not-run"].includes(receipt.smoke?.status) ||
      (receipt.smoke.status === "not-run" && !receipt.smoke.reason)
    )
      throw new Error(`Invalid collected receipt: ${target}`);
    requireAssets(jobPlan("", "", plan, ...target.split("-")), receipt.assets, fleet.version);
  }
  const actual = inventory(directory);
  if (
    JSON.stringify(
      actual.filter((asset) => !["build-provenance.json", "SHA256SUMS"].includes(asset.name)),
    ) !== JSON.stringify(assets)
  )
    throw new Error("Collected assets changed");
  for (const receipt of receipts)
    for (const asset of receipt.assets)
      if (releaseAsset(asset.name) && !asset.name.endsWith(".yml")) {
        const match = actual.find((entry) => entry.name === asset.name);
        if (JSON.stringify(match) !== JSON.stringify(asset))
          throw new Error(`Receipt asset mismatch: ${asset.name}`);
      }
  for (const name of [
    "nightly-mac.yml",
    "nightly.yml",
    "nightly-linux.yml",
    "nightly-linux-arm64.yml",
    "release-notes.md",
    `t3-source-${fleet.version}.bundle`,
  ])
    if (!actual.some((asset) => asset.name === name))
      throw new Error(`Missing release asset: ${name}`);
  const sums = NodeFS.readFileSync(NodePath.join(directory, "SHA256SUMS"), "utf8");
  if (
    sums !==
    actual
      .filter((asset) => asset.name !== "SHA256SUMS")
      .map((asset) => `${asset.sha256}  ${asset.name}\n`)
      .join("")
  )
    throw new Error("Checksums do not cover the exact release inventory");
  return { plan, assets: actual };
}
export function collect(root, directory) {
  const plan = readJson(NodePath.join(directory, "build-plan.json"));
  const fleet = readFleet(directory, plan.fleet.version);
  assertSource(root, fleet);
  if (JSON.stringify(releasePlan(root, fleet, directory)) !== JSON.stringify(plan))
    throw new Error("Build plan changed");
  const receipts = targets.map((target) => verifyJob(directory, plan, ...target.split("-")));
  const destination = NodePath.join(directory, "artifacts");
  if (NodeFS.existsSync(destination)) {
    const existing = verifyCollected(destination);
    if (JSON.stringify(existing.plan) !== JSON.stringify(plan))
      throw new Error("Collected plan differs");
    return {
      result: "reused",
      identity: plan.identity,
      directory: destination,
      assets: existing.assets,
    };
  }
  const temporary = NodeFS.mkdtempSync(NodePath.join(directory, ".collect-"));
  try {
    const copy = (from, name) => {
      const to = NodePath.join(temporary, name);
      if (NodeFS.existsSync(to)) {
        if (fileHash(to) !== fileHash(from)) throw new Error(`Conflicting asset: ${name}`);
        return;
      }
      NodeFS.copyFileSync(from, to);
    };
    for (const receipt of receipts)
      for (const asset of receipt.assets)
        if (releaseAsset(asset.name))
          copy(NodePath.join(directory, "jobs", receipt.target, "assets", asset.name), asset.name);
    for (const name of ["mzs-fleet.json", "release-notes.md", `t3-source-${fleet.version}.bundle`])
      copy(NodePath.join(directory, name), name);
    const merge = (platform, first, second, output) =>
      execute(
        process.execPath,
        [
          "scripts/merge-update-manifests.ts",
          "--platform",
          platform,
          ...[first, second, output].map((name) => NodePath.join(temporary, name)),
        ],
        root,
        buildEnvironment(fleet),
      );
    merge("mac", "nightly-mac.yml", "nightly-mac-x64.yml", "nightly-mac.yml");
    merge("win", "nightly-win-x64.yml", "nightly-win-arm64.yml", "nightly.yml");
    writeJson(NodePath.join(temporary, "build-provenance.json"), {
      plan,
      receipts,
      assets: inventory(temporary),
    });
    const assets = inventory(temporary);
    NodeFS.writeFileSync(
      NodePath.join(temporary, "SHA256SUMS"),
      assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""),
    );
    verifyCollected(temporary);
    NodeFS.renameSync(temporary, destination);
    return {
      result: "collected",
      identity: plan.identity,
      directory: destination,
      assets: inventory(destination),
    };
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodeFS.realpathSync(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  let result;
  if (args[0] === "import-inputs" && args.length === 4)
    result = importInputs(...args.slice(1).map((path) => NodePath.resolve(path)));
  else if (args[0] === "collect" && args.length === 3)
    result = collect(NodePath.resolve(args[1]), NodePath.resolve(args[2]));
  else {
    const dryRun = args.at(-1) === "--dry-run";
    if (dryRun) args.pop();
    if (args.length !== 5)
      throw new Error(
        "Usage: local-build.mjs <source-root> <release-dir> <version> <platform> <arch> [--dry-run] | collect <source-root> <release-dir> | import-inputs <source-root> <release-dir> <buildkit-dir>",
      );
    result = build(
      NodePath.resolve(args[0]),
      NodePath.resolve(args[1]),
      args[2],
      args[3],
      args[4],
      dryRun,
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
