import { assert } from "@effect/vitest";
import { describe, it as plainIt } from "vite-plus/test";

import { resolveDesktopUpdateChannel, resolveStageAllowBuilds } from "./build-desktop-artifact.ts";

describe("fleet desktop artifact", () => {
  plainIt("keeps MZS fleet builds on the nightly channel", () => {
    assert.equal(
      resolveDesktopUpdateChannel("0.0.34-nightly.20260824.1172.mzs.r1234abcdef56"),
      "nightly",
    );
  });

  plainIt("keeps install scripts only for a stage that matches the host", () => {
    const allowBuilds = { electron: true, "node-pty": true, "msgpackr-extract": true };
    assert.deepStrictEqual(
      resolveStageAllowBuilds(allowBuilds, {
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      allowBuilds,
    );
    for (const stage of [
      { platform: "mac", arch: "x64" },
      { platform: "win", arch: "arm64" },
      { platform: "linux", arch: "arm64" },
    ] as const) {
      assert.deepStrictEqual(
        resolveStageAllowBuilds(allowBuilds, { ...stage, hostPlatform: "linux", hostArch: "x64" }),
        { electron: true, "node-pty": false, "msgpackr-extract": false },
      );
    }
  });
});
