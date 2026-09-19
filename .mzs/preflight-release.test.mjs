import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { assertFleetUpdateRouting, fleetUpdateTests, smokeCli } from "./preflight-release.mjs";

const version = "0.0.39-nightly.20260907.1325.mzs.r123456abcdef";
function fixture(test, source) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-smoke-test-"));
  test.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  NodeFS.mkdirSync(NodePath.join(root, "apps/server/dist"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), source);
  return NodePath.join(root, "apps/server/dist/bin.mjs");
}
const cli = `console.log(process.argv.includes("--version") ? "t3 v${version}" : "USAGE t3");`;

NodeTest.test("accepts CLI commands with and without a configured home", (test) => {
  smokeCli(fixture(test, cli), version);
});

NodeTest.test("rejects correct version output followed by launcher startup failure", (test) => {
  const root = fixture(
    test,
    `${cli}
    console.error("[service-launcher] T3CODE_HOME is required");
    process.exitCode = 1;`,
  );
  NodeAssert.throws(() => smokeCli(root, version), /CLI --version failed.*T3CODE_HOME/);
});

NodeTest.test("rejects launcher state writes even with a successful exit", (test) => {
  const root = fixture(
    test,
    `${cli}
    if (process.env.T3CODE_HOME) {
      const fs = await import("node:fs");
      fs.mkdirSync(process.env.T3CODE_HOME);
    }`,
  );
  NodeAssert.throws(() => smokeCli(root, version), /wrote runtime state/);
});

NodeTest.test("rejects wrong versions and missing help", (test) => {
  NodeAssert.throws(
    () => smokeCli(fixture(test, 'console.log("v0.0.0");'), version),
    /version mismatch/,
  );
  NodeAssert.throws(
    () =>
      smokeCli(
        fixture(test, `if (process.argv.includes("--version")) console.log("t3 v${version}");`),
        version,
      ),
    /help missing usage/,
  );
});

NodeTest.test("release preflight cannot omit fleet update behavior tests", () => {
  const source = NodeFS.readFileSync(new URL("./preflight-release.mjs", import.meta.url), "utf8");
  NodeAssert.match(source, /assertFleetUpdateRouting\(root\);/);
  NodeAssert.match(source, /new Set\(\[\.\.\.manifest.tests, \.\.\.fleetUpdateTests\]\)/);
  NodeAssert.ok(fleetUpdateTests.includes("apps/server/src/cloud/selfUpdate.test.ts"));
  NodeAssert.ok(fleetUpdateTests.includes("apps/web/src/components/ServerUpdateAction.test.tsx"));
});

NodeTest.test("release rejects missing fleet routing before dependencies or builds", (test) => {
  const root = NodePath.dirname(NodePath.dirname(NodePath.dirname(fixture(test, cli))));
  NodeAssert.throws(() => assertFleetUpdateRouting(root), /ENOENT/);
  const shared = NodePath.join(root, "packages/shared/src");
  NodeFS.mkdirSync(shared, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(shared, "fleetRelease.ts"),
    'export const cliReleaseDownloadBaseUrl = () => "https://registry.npmjs.org/t3";',
  );
  NodeAssert.throws(() => assertFleetUpdateRouting(root), /Fleet update routing missing/);
});

for (const failedStage of ["typecheck", "electron", "tests"]) {
  NodeTest.test(`release stops at ${failedStage} before expensive downstream work`, (test) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-preflight-order-"));
    test.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const files = {
      "packages/shared/src/fleetRelease.ts": "msegec/t3code_rookie",
      "packages/shared/src/cliRelease.ts":
        "FLEET_RELEASE_BASE_URL FLEET_RELEASE_REPOSITORY cliReleaseDownloadBaseUrl",
      "apps/server/src/cloud/pinnedRuntime.ts": "cliReleaseDownloadBaseUrl",
      "packages/ssh/src/tunnel.ts": "cliReleaseDownloadBaseUrl",
      "apps/server/src/cloud/selfUpdate.ts":
        "ensurePinnedRuntimeInstalled({ launcher.requestUpdate({ targetVersion",
      "apps/web/src/components/ServerUpdateAction.tsx": "serverEnvironment.updateServer",
      "apps/web/src/components/sidebar/SidebarUpdatePill.tsx":
        ".downloadUpdate() .installUpdate() DesktopUpdateStatusIcon",
      "scripts/build-desktop-artifact.ts": "T3CODE_DESKTOP_UPDATE_REPOSITORY",
      ...Object.fromEntries(fleetUpdateTests.map((file) => [file, ""])),
      "manifest.json": JSON.stringify({ tests: ["selected.test.ts", fleetUpdateTests[0]] }),
    };
    for (const [file, contents] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), contents);
    }
    NodeFS.writeFileSync(
      NodePath.join(root, "vp"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("commands.jsonl", JSON.stringify(args) + "\\n");
if (args.includes(${JSON.stringify({ typecheck: "typecheck", electron: "ensure:electron", tests: "test" }[failedStage])})) {
  process.exitCode = 7;
}
`,
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./preflight-release.mjs", import.meta.url)),
        root,
        NodePath.join(root, "manifest.json"),
        version,
      ],
      {
        env: { ...process.env, PATH: `${root}${NodePath.delimiter}${process.env.PATH}` },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    NodeAssert.equal(result.status, 1, result.stderr);
    NodeAssert.match(result.stderr, /vp failed: 7/);
    const commands = NodeFS.readFileSync(NodePath.join(root, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    NodeAssert.equal(commands.length, { typecheck: 3, electron: 4, tests: 5 }[failedStage]);
    NodeAssert.deepEqual(commands[0], ["i", "--frozen-lockfile", "--ignore-scripts"]);
    NodeAssert.equal(commands[2].at(-1), "typecheck");
    if (failedStage !== "typecheck") {
      NodeAssert.deepEqual(commands[3], ["run", "--filter", "@t3tools/desktop", "ensure:electron"]);
    }
    if (failedStage === "tests") {
      NodeAssert.deepEqual(commands[4], ["test", "run", "selected.test.ts", ...fleetUpdateTests]);
    }
    NodeAssert.doesNotMatch(result.stderr, /fleet_phase=preflight_(version|build|cli|package)/);
    NodeAssert.doesNotMatch(result.stderr, /fleet_preflight=passed/);
  });
}
