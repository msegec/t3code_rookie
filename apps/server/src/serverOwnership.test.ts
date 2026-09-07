import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import { makeServerLayer } from "./server.ts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { acquireServerOwnership } from "./serverOwnership.ts";

describe("server ownership", () => {
  it.effect(
    "rejects a second server before it can open the shared database, and releases on shutdown",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
        const config = {
          dbPath: path.join(root, "state.sqlite"),
          serverRuntimeStatePath: path.join(root, "runtime.json"),
        };
        const owner = yield* Scope.make();
        yield* acquireServerOwnership(config).pipe(Scope.provide(owner));
        const duplicate = yield* acquireServerOwnership(config).pipe(Effect.scoped, Effect.exit);
        assert.isTrue(Exit.isFailure(duplicate));
        assert.isFalse(yield* fs.exists(config.dbPath));
        yield* Scope.close(owner, Exit.void);
        yield* acquireServerOwnership(config);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("stops duplicate startup before opening the application database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* acquireServerOwnership(config);
      const startup = yield* Layer.build(makeServerLayer).pipe(Effect.scoped, Effect.exit);
      assert.isTrue(Exit.isFailure(startup));
      if (Exit.isFailure(startup))
        assert.include(String(startup.cause), "Cannot start another T3 server");
      assert.isFalse(yield* fs.exists(config.dbPath));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-startup-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("allows one simultaneous starter and treats home aliases as the same owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      yield* fs.makeDirectory(`${root}/home`);
      yield* fs.symlink(`${root}/home`, `${root}/alias`);
      const scopes = yield* Effect.all([Scope.make(), Scope.make()]);
      const results = yield* Effect.all(
        scopes.map((scope, index) =>
          acquireServerOwnership({
            dbPath: `${root}/${index === 0 ? "home" : "alias"}/state.sqlite`,
            serverRuntimeStatePath: `${root}/runtime.json`,
          }).pipe(Scope.provide(scope), Effect.exit),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Exit.isSuccess).length, 1);
      assert.equal(results.filter(Exit.isFailure).length, 1);
      yield* Effect.all(scopes.map((scope) => Scope.close(scope, Exit.void)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a stale receipt pointing to an unrelated live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-stale-" });
      const config = {
        dbPath: `${root}/state.sqlite`,
        serverRuntimeStatePath: `${root}/runtime.json`,
      };
      const unrelated = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ["-e", 'process.stdout.write("ready\\n"); process.stdin.resume();'],
          { stdin: Stream.never },
        ),
      );
      const ready = yield* unrelated.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.deepEqual(ready, ["ready"]);
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: {
          version: 1,
          pid: unrelated.pid,
          port: 3774,
          origin: "http://127.0.0.1:3774",
          startedAt: "2026-09-07T00:00:00Z",
        },
      });
      yield* acquireServerOwnership(config).pipe(Effect.scoped);
      assert.isFalse(yield* fs.exists(config.dbPath));
      if ((yield* HostProcessPlatform) === "linux") {
        yield* fs.writeFileString(config.dbPath, "existing database");
        yield* acquireServerOwnership(config).pipe(Effect.scoped);
        assert.equal(yield* fs.readFileString(config.dbPath), "existing database");
      }
      assert.isTrue(yield* unrelated.isRunning);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the exclusive lock to recover a guarded receipt after PID reuse", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-guarded-" });
      const config = {
        dbPath: `${root}/state.sqlite`,
        serverRuntimeStatePath: `${root}/runtime.json`,
      };
      yield* fs.writeFileString(config.dbPath, "existing database");
      const unrelated = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready\\n"); process.stdin.resume();',
            config.dbPath,
          ],
          { stdin: Stream.never },
        ),
      );
      const ready = yield* unrelated.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.deepEqual(ready, ["ready"]);
      const state = yield* makePersistedServerRuntimeState({
        config: {
          host: "127.0.0.1",
          devUrl: undefined,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        port: 3774,
      });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: { ...state, pid: unrelated.pid },
      });
      yield* acquireServerOwnership(config);
      assert.equal(yield* fs.readFileString(config.dbPath), "existing database");
      assert.isTrue(yield* unrelated.isRunning);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a live legacy owner even before a lock file existed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const config = {
        dbPath: `${root}/state.sqlite`,
        serverRuntimeStatePath: `${root}/runtime.json`,
      };
      yield* fs.writeFileString(config.dbPath, "legacy database");
      yield* fs.open(config.dbPath);
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: {
          version: 1,
          pid: process.pid,
          port: 3774,
          origin: "http://127.0.0.1:3774",
          startedAt: "2026-09-07T00:00:00Z",
        },
      });
      assert.isTrue(
        Exit.isFailure(yield* acquireServerOwnership(config).pipe(Effect.scoped, Effect.exit)),
      );
      assert.equal(yield* fs.readFileString(config.dbPath), "legacy database");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases the ownership lock when its process crashes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-crash-" });
      const config = {
        dbPath: `${root}/state.sqlite`,
        serverRuntimeStatePath: `${root}/runtime.json`,
      };
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import * as Effect from "effect/Effect";
        import * as NodeServices from "@effect/platform-node/NodeServices";
        import { acquireServerOwnership } from "./src/serverOwnership.ts";
        await Effect.runPromise(Effect.gen(function* () {
          yield* acquireServerOwnership({dbPath: process.argv[1], serverRuntimeStatePath: process.argv[2]});
          yield* Effect.sync(() => process.stdout.write("owned\\n"));
          yield* Effect.never;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
      `,
            config.dbPath,
            config.serverRuntimeStatePath,
          ],
          { cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)) },
        ),
      );
      const ready = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      assert.deepEqual(ready, ["owned"]);
      assert.isTrue(
        Exit.isFailure(yield* acquireServerOwnership(config).pipe(Effect.scoped, Effect.exit)),
      );
      yield* child.kill({ killSignal: "SIGKILL" });
      const killed = yield* child.exitCode.pipe(Effect.flip);
      assert.include(String(killed.reason.cause), "SIGKILL");
      yield* acquireServerOwnership(config);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
