import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const script = NodeURL.fileURLToPath(new URL("./build-browser-secret.mjs", import.meta.url));

describe("prebuilt browser secret", () => {
  it.each([["valid"], ["wrong digest"], ["wrong architecture"], ["missing digest"]])(
    "%s",
    (scenario) => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-browser-secret-prebuilt-"),
      );
      try {
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
        expect(result.error).toBeUndefined();
        if (scenario === "valid") {
          expect(result.status).toBe(0);
          expect(NodeFS.readFileSync(output)).toEqual(bytes);
          expect(NodeFS.statSync(output).mode & 0o777).toBe(0o755);
        } else {
          expect(result.status).not.toBe(0);
          expect(NodeFS.existsSync(output)).toBe(false);
          expect(result.stderr).toMatch(/Prebuilt browser secret/);
        }
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
