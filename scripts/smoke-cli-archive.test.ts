import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { smokeArchivePty } from "./smoke-cli-archive.ts";

for (const invalidNativeAddon of [false, true]) {
  it.live(`rejects ${invalidNativeAddon ? "unloadable" : "missing"} archive node-pty`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const archive = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pty-test-" });
      if (invalidNativeAddon) {
        const pty = path.join(archive, "node_modules/node-pty");
        yield* fs.makeDirectory(pty, { recursive: true });
        yield* fs.writeFileString(path.join(pty, "index.js"), 'require("./pty.node")');
        yield* fs.writeFileString(path.join(pty, "pty.node"), "invalid native binary");
      }
      const result = yield* smokeArchivePty(archive).pipe(Effect.flip);
      assert.equal(result._tag, "CliArchiveSmokeError");
      assert.equal(result.step, "spawning a PTY");
      assert.include(result.detail, invalidNativeAddon ? "ERR_DLOPEN_FAILED" : "MODULE_NOT_FOUND");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
