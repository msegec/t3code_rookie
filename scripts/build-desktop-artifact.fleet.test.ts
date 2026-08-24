import { assert, describe, it } from "vite-plus/test";

import { resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";

describe("fleet desktop artifact", () => {
  it("keeps MZS fleet builds on the nightly channel", () => {
    assert.equal(
      resolveDesktopUpdateChannel("0.0.34-nightly.20260824.1172.mzs.r1234abcdef56"),
      "nightly",
    );
  });
});
