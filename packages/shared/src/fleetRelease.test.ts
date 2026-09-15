import { assert, describe, it } from "@effect/vitest";

import { isFleetVersion } from "./fleetRelease.ts";

describe("fleetRelease", () => {
  it("recognises revisioned fleet versions only", () => {
    assert.isTrue(isFleetVersion("0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b2"));
    assert.isFalse(isFleetVersion("0.0.38-nightly.20260901.1248"));
    assert.isFalse(isFleetVersion("0.0.38"));
    assert.isFalse(isFleetVersion("0.0.0-dev"));
    assert.isFalse(isFleetVersion("0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b"));
  });
});
