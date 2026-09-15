// @effect-diagnostics nodeBuiltinImport:off - reads the repository lockfile as a fixture.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

import {
  WorkspaceLock,
  resolveCatalogDependencies,
  resolveLockedDependencies,
  workspaceLockDocument,
} from "./resolve-catalog.ts";

const catalog = { effect: "4.0.0-rc.115", "@clerk/backend": "3.18.1", react: "19.2.0" };

describe("resolveCatalogDependencies", () => {
  it("resolves bare, named and override-selector catalog specs like pnpm", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "@clerk/backend": "catalog:",
          "react-dom": "catalog:react",
          "@opencode/protocol>effect": "catalog:",
          "dbus-next>usocket": "-",
          lodash: "4.17.21",
        },
        catalog,
        "apps/desktop",
      ),
      {
        "@clerk/backend": "3.18.1",
        "react-dom": "19.2.0",
        "@opencode/protocol>effect": "4.0.0-rc.115",
        "dbus-next>usocket": "-",
        lodash: "4.17.21",
      },
    );
  });

  it("resolves version-qualified overrides without changing their selectors", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "undici@^8": "catalog:",
          "ws@^8": "catalog:",
          "@clerk/backend@^3": "catalog:",
          "@scope/parent@^1>undici@^8": "catalog:",
          "parent@^1>@clerk/backend@^3": "catalog:",
        },
        { ...catalog, undici: "8.11.2", ws: "8.21.0" },
        "apps/desktop",
      ),
      {
        "undici@^8": "8.11.2",
        "ws@^8": "8.21.0",
        "@clerk/backend@^3": "3.18.1",
        "@scope/parent@^1>undici@^8": "8.11.2",
        "parent@^1>@clerk/backend@^3": "3.18.1",
      },
    );
  });
});

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

describe("workspaceLockDocument", () => {
  it("decodes the repository lockfile, including pnpm's leading install lock", () => {
    const lockfile = NodeFS.readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
    const lock = Schema.decodeSync(fromYaml(WorkspaceLock))(workspaceLockDocument(lockfile));
    assert.ok(lock.importers["apps/server"]);
  });
});
