import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const script = NodeURL.fileURLToPath(new URL("./build-browser-secret.mjs", import.meta.url));

for (const scenario of ["valid", "wrong digest", "wrong architecture", "missing digest"]) {
  NodeTest.test(`prebuilt browser secret: ${scenario}`, (test) => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-browser-secret-prebuilt-"),
    );
    test.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const prebuilt = NodePath.join(directory, "prebuilt");
    const output = NodePath.join(directory, "output", "helper");
    const bytes = Buffer.alloc(64);
    bytes.write("7f454c460201", "hex");
    bytes.writeUInt16LE(scenario === "wrong architecture" ? 62 : 183, 18);
    NodeFS.writeFileSync(prebuilt, bytes);
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const args = [script, "--arch", "arm64", "--output", output, "--prebuilt", prebuilt];
    if (scenario !== "missing digest") {
      args.push("--prebuilt-sha256", scenario === "wrong digest" ? "0".repeat(64) : digest);
    }
    const result = NodeChildProcess.spawnSync(process.execPath, args, {
      env: { PATH: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    NodeAssert.equal(result.error, undefined);
    if (scenario === "valid") {
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.deepEqual(NodeFS.readFileSync(output), bytes);
      NodeAssert.equal(NodeFS.statSync(output).mode & 0o777, 0o755);
    } else {
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.equal(NodeFS.existsSync(output), false);
      NodeAssert.match(result.stderr, /Prebuilt browser secret/);
    }
  });
}
