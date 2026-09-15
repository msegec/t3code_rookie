import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps MZS fleet builds branded as nightly and on the nightly channel", () => {
    const version = "0.0.34-nightly.20260824.1172.mzs.r1234abcdef56";
    expect(isNightlyDesktopVersion(version)).toBe(true);
    expect(desktopUpdateChannelOf(version)).toBe("nightly");
  });
});
