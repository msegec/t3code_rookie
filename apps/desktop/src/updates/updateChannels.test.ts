import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps MZS fleet builds branded as nightly and on the nightly channel", () => {
    const version = "0.0.34-nightly.20260824.1172.mzs.r1234abcdef56";
    expect(isNightlyDesktopVersion(version)).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel(version)).toBe("nightly");
  });

  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
