import { describe, expect, it } from "vite-plus/test";

import { resolveFleetSyncStatus } from "./fleetBuild";

describe("resolveFleetSyncStatus", () => {
  it("reports a newer official nightly", () => {
    expect(
      resolveFleetSyncStatus("v0.0.34-nightly.20260824.1172", [
        "v0.0.34-nightly.20260824.1172",
        "v0.0.34-nightly.20260825.1179",
      ]),
    ).toEqual({ status: "available", latestTag: "v0.0.34-nightly.20260825.1179" });
  });

  it("keeps the current build when no newer nightly exists", () => {
    expect(
      resolveFleetSyncStatus("v0.0.34-nightly.20260824.1172", [
        "v0.0.34-nightly.20260824.1172",
        "v0.0.34-nightly.20260823.1168",
      ]),
    ).toEqual({ status: "current" });
  });

  it("ignores stable and malformed releases", () => {
    expect(
      resolveFleetSyncStatus("v0.0.34-nightly.20260824.1172", ["v0.0.35", "fleet-v0.0.35"]),
    ).toEqual({ status: "unavailable" });
  });
});
