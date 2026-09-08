import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { smokeCli } from "./preflight-release.mjs";

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
