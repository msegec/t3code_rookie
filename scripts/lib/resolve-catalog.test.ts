import { assert, describe, it } from "@effect/vitest";
import { resolveLockedDependencies } from "./resolve-catalog.ts";

describe("resolveLockedDependencies", () => {
  it("pins selected runtime packages to lock versions, stripping patch and peer qualifiers", () => {
    assert.deepEqual(
      resolveLockedDependencies(
        { "node-pty": "^1.1.0", "@ff-labs/fff-node": "0.9.4" },
        {
          importers: {
            "apps/server": {
              dependencies: {
                "node-pty": { version: "1.1.0(peer@2.0.0)" },
                "@ff-labs/fff-node": { version: "0.9.4(patch_hash=abc)" },
                effect: { version: "4.0.0-rc.112" },
              },
            },
          },
        },
        "apps/server",
      ),
      { "node-pty": "1.1.0", "@ff-labs/fff-node": "0.9.4" },
    );
  });

  for (const version of [
    undefined,
    "^1.1.0",
    "link:../native",
    "file:../native",
    "npm:other@1.1.0",
  ]) {
    it(`rejects unavailable or non-exact lock version ${String(version)}`, () => {
      assert.throws(
        () =>
          resolveLockedDependencies(
            { "node-pty": "^1.1.0" },
            {
              importers: {
                "apps/server": { dependencies: version ? { "node-pty": { version } } : {} },
              },
            },
            "apps/server",
          ),
        /Missing exact locked version/,
      );
    });
  }
});
