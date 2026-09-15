// @effect-diagnostics nodeBuiltinImport:off - electron-builder loads this afterPack hook as a plain Node module.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export default async function sign(context: {
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}): Promise<void> {
  await NodeUtil.promisify(NodeChildProcess.execFile)(
    "rcodesign",
    [
      "--config-file",
      "/dev/null",
      "sign",
      "--timestamp-url",
      "none",
      NodePath.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    ],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
}
