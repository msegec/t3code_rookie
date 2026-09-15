import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stageClientAssets } from "./build-cli-archive.ts";

for (const fleet of [false, true]) {
  it.effect(`stages client assets with fleet provenance ${String(fleet)}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = path.join(root, "dist/client");
      const target = path.join(root, "archive/client");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(path.join(source, "index.html"), "client");
      yield* fs.writeFileString(path.join(source, "index.js.map"), "map");
      const manifest = '{"sourceSha":"pinned-source","schemaVersion":1}';
      if (fleet) {
        yield* fs.writeFileString(path.join(root, "dist/mzs-fleet.json"), manifest);
      }
      yield* stageClientAssets(source, target);
      assert.equal(yield* fs.readFileString(path.join(target, "index.html")), "client");
      assert.isFalse(yield* fs.exists(path.join(target, "index.js.map")));
      const provenance = path.join(root, "archive/mzs-fleet.json");
      assert.equal(yield* fs.exists(provenance), fleet);
      if (fleet) assert.equal(yield* fs.readFileString(provenance), manifest);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
