import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const fleetUpdateTests = [
  "packages/shared/src/fleetRelease.test.ts",
  "packages/ssh/src/command.test.ts",
  "apps/server/src/cloud/pinnedRuntime.test.ts",
  "apps/server/src/cloud/selfUpdate.test.ts",
  "apps/server/src/cloud/bootService.test.ts",
  "apps/web/src/components/ServerUpdateAction.test.tsx",
  "apps/desktop/src/updates/updateChannels.test.ts",
  "scripts/build-desktop-artifact.fleet.test.ts",
];

export function assertFleetUpdateRouting(root) {
  const required = {
    "packages/shared/src/fleetRelease.ts": [
      "https://github.com/msegec/t3code_rookie/releases/download",
      "fleetReleaseTarballUrl",
    ],
    "apps/server/src/cloud/pinnedRuntime.ts": [
      "fleetReleaseTarballUrl(version)",
      "pinnedRuntimePackageSpec(input.version)",
    ],
    "packages/ssh/src/command.ts": ["fleetReleaseTarballUrl(appVersion)"],
    "apps/server/src/cloud/selfUpdate.ts": [
      "ensurePinnedRuntimeInstalled({",
      "launcher.requestUpdate({ targetVersion",
    ],
    "apps/web/src/components/ServerUpdateAction.tsx": ["serverEnvironment.updateServer"],
    "apps/web/src/components/sidebar/SidebarUpdatePill.tsx": [
      ".downloadUpdate()",
      ".installUpdate()",
      "DesktopUpdateStatusIcon",
    ],
    "scripts/build-desktop-artifact.ts": ["T3CODE_DESKTOP_UPDATE_REPOSITORY"],
  };
  for (const [file, tokens] of Object.entries(required)) {
    const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    for (const token of tokens) {
      if (!source.includes(token))
        throw new Error(`Fleet update routing missing: ${file}: ${token}`);
    }
  }
  for (const file of fleetUpdateTests) {
    if (!NodeFS.existsSync(NodePath.join(root, file))) {
      throw new Error(`Fleet update regression missing: ${file}`);
    }
  }
}

function run(command, args, options) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15 * 60_000,
    stdio: ["ignore", 2, 2],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.signal ?? result.status}`);
}

export function smokeCli(entrypoint, version) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-smoke-"));
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CACHE_HOME: home,
      NO_COLOR: "1",
    };
    for (const configured of [false, true]) {
      for (const argument of ["--version", "--help"]) {
        const result = NodeChildProcess.spawnSync(process.execPath, [entrypoint, argument], {
          cwd: home,
          env: configured ? { ...env, T3CODE_HOME: NodePath.join(home, "t3") } : env,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        if (result.error) throw result.error;
        if (result.status !== 0 || result.stderr.trim()) {
          throw new Error(
            `CLI ${argument} failed (home=${configured}, exit=${result.status}): ${result.stderr.trim()}`,
          );
        }
        if (argument === "--version" && result.stdout.trim() !== `t3 v${version}`) {
          throw new Error(`CLI version mismatch: ${result.stdout.trim()}`);
        }
        if (argument === "--help" && !result.stdout.includes("USAGE")) {
          throw new Error("CLI help missing usage");
        }
        if (NodeFS.readdirSync(home).length !== 0) {
          throw new Error(`CLI ${argument} wrote runtime state`);
        }
      }
    }
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

export function packageServer(root, output, version) {
  const temporary = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(output), "t3-package-smoke-"),
  );
  try {
    const staged = NodePath.join(temporary, "package");
    const installed = NodePath.join(temporary, "installed");
    run(process.execPath, [
      NodeURL.fileURLToPath(new URL("./stage-server-package.mjs", import.meta.url)),
      root,
      staged,
      version,
    ]);
    NodeFS.mkdirSync(output, { recursive: true });
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], { cwd: staged });
    const artifact = NodePath.join(output, `t3-${version}.tgz`);
    run(
      "npm",
      ["install", "--prefix", installed, "--ignore-scripts", "--no-fund", "--no-audit", artifact],
      { cwd: temporary },
    );
    run("npm", ["rebuild", "node-pty", "--prefix", installed, "--no-fund", "--no-audit"], {
      cwd: temporary,
    });
    run(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `
      const pty = require("node-pty").spawn(process.execPath, [
        "-e", "process.stdout.write('t3-pty-smoke')",
      ], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
      let output = "";
      pty.onData((data) => { output += data; });
      pty.onExit(({ exitCode }) => {
        if (exitCode !== 0 || output !== "t3-pty-smoke") {
          throw new Error("Installed terminal smoke failed: " + JSON.stringify({ exitCode, output }));
        }
      });
    `,
      ],
      { cwd: NodePath.join(installed, "node_modules/t3"), timeout: 15_000 },
    );
    smokeCli(NodePath.join(installed, "node_modules/t3/dist/bin.mjs"), version);
    return artifact;
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

function preflight(root, manifestPath, version) {
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (
    !Array.isArray(manifest.tests) ||
    !manifest.tests.length ||
    manifest.tests.some(
      (file) =>
        typeof file !== "string" ||
        (!file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) ||
        file.startsWith("-") ||
        NodePath.isAbsolute(file) ||
        file.split("/").includes(".."),
    )
  ) {
    throw new Error("Invalid release test selection");
  }
  assertFleetUpdateRouting(root);
  const options = { cwd: root, env: { ...process.env, VITE_MZS_FLEET_LABEL: "MZS Fleet" } };
  const step = (name, command, args) => {
    process.stderr.write(`fleet_phase=preflight_${name}\n`);
    run(command, args, options);
  };
  step("install", "vp", ["i", "--frozen-lockfile"]);
  step("tests", "vp", ["test", "run", ...new Set([...manifest.tests, ...fleetUpdateTests])]);
  step("typecheck", "vp", [
    "run",
    ...[
      "t3",
      "@t3tools/web",
      "@t3tools/desktop",
      "@t3tools/mobile",
      "@t3tools/contracts",
      "@t3tools/client-runtime",
      "@t3tools/shared",
      "@t3tools/scripts",
    ].flatMap((name) => ["--filter", name]),
    "typecheck",
  ]);
  step("version", process.execPath, ["scripts/update-release-package-versions.ts", version]);
  NodeFS.copyFileSync(NodePath.join(root, ".env.example"), NodePath.join(root, ".env"));
  step("build", "vp", ["run", "--filter", "t3", "build"]);
  process.stderr.write("fleet_phase=preflight_cli\n");
  smokeCli(NodePath.join(root, "apps/server/dist/bin.mjs"), version);
  process.stderr.write("fleet_phase=preflight_package\n");
  const output = NodeFS.mkdtempSync(NodePath.join(root, ".fleet-package-"));
  try {
    packageServer(root, output, version);
  } finally {
    NodeFS.rmSync(output, { recursive: true, force: true });
  }
  process.stderr.write("fleet_preflight=passed\n");
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  const packageOnly = process.argv[2] === "--package";
  const [root, manifest, version, ...extra] = process.argv.slice(packageOnly ? 3 : 2);
  if (
    !root ||
    !manifest ||
    !/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.mzs\.r[0-9a-f]{12}$/.test(version ?? "") ||
    extra.length
  ) {
    throw new Error(
      "Usage: preflight-release.mjs [--package] <composed-root> <manifest-path|output-dir> <release-version>",
    );
  }
  (packageOnly ? packageServer : preflight)(
    NodePath.resolve(root),
    NodePath.resolve(manifest),
    version,
  );
}
