import { describe, expect, it } from "vite-plus/test";

import { resolveServerBackedAppStageLabel } from "./branding.logic";

describe("branding logic", () => {
  it("returns Nightly for MZS fleet server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.34-nightly.20260824.1172.mzs.r1234abcdef56",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });
});
