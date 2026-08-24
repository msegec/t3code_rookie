import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("isNightlyDesktopVersion", () => {
  it("keeps MZS fleet builds on the nightly channel", () => {
    expect(isNightlyDesktopVersion("0.0.34-nightly.20260824.1172.mzs.r1234abcdef56")).toBe(true);
  });
});
