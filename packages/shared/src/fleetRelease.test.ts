import { assert, describe, it } from "@effect/vitest";

import { fleetReleaseTarballUrl, isFleetVersion } from "./fleetRelease.ts";

describe("fleetRelease", () => {
  it("recognises revisioned fleet versions only", () => {
    assert.isTrue(isFleetVersion("0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b2"));
    assert.isFalse(isFleetVersion("0.0.38-nightly.20260901.1248"));
    assert.isFalse(isFleetVersion("0.0.38"));
    assert.isFalse(isFleetVersion("0.0.0-dev"));
    assert.isFalse(isFleetVersion("0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b"));
  });

  it("builds the fleet release tarball url", () => {
    assert.equal(
      fleetReleaseTarballUrl("0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b2"),
      "https://github.com/msegec/t3code_rookie/releases/download/v0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b2/t3-0.0.38-nightly.20260901.1248.mzs.rf61ce767a0b2.tgz",
    );
  });
});
