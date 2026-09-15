import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { persistServerRuntimeState } from "./serverRuntimeState.ts";
import * as ServiceLauncher from "./serviceLauncher.ts";
import { watchServerReadiness } from "./serviceReadiness.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })("replacement readiness", (it) => {
  it.effect("observes atomic runtime publication after subscribing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ready-" });
      const file = path.join(directory, "server-runtime.json");
      const ready = yield* watchServerReadiness({
        path: file,
        endpoint: { port: 3774, host: "127.0.0.1" },
        previousPid: 1,
      });
      yield* persistServerRuntimeState({
        path: file,
        state: {
          version: 1,
          pid: process.pid,
          port: 3774,
          host: "127.0.0.1",
          origin: "http://127.0.0.1:3774",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
      assert.equal((yield* ready.awaitReady).pid, process.pid);
    }),
  );

  it.effect("releases the native watcher when readiness fails", () =>
    Effect.gen(function* () {
      const close = vi.fn(() => Promise.resolve());
      const start = vi
        .spyOn(ServiceLauncher, "startServerReadinessWatch")
        .mockReturnValue({ result: Promise.resolve({ reason: "timeout" }), close });
      try {
        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* watchServerReadiness({
              path: "/unused",
              endpoint: { port: 3774 },
            });
            return yield* ready.awaitReady.pipe(Effect.flip);
          }),
        );
        assert.equal(failure.reason, "timeout");
        assert.equal(close.mock.calls.length, 1);
      } finally {
        start.mockRestore();
      }
    }),
  );

  it.effect("never accepts the old PID or a changed endpoint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ready-" });
      const file = path.join(directory, "server-runtime.json");
      for (const mismatch of [
        { pid: process.pid, previousPid: process.pid, port: 3774 },
        { pid: process.pid, previousPid: 1, port: 3773 },
        { pid: 0, previousPid: 1, port: 3774 },
        { pid: 2147483647, previousPid: 1, port: 3774 },
        { pid: process.pid, previousPid: 1, port: 3774, startedAt: "2000-01-01T00:00:00Z" },
      ]) {
        const ready = yield* watchServerReadiness({
          path: file,
          endpoint: { port: mismatch.port, host: "127.0.0.1" },
          previousPid: mismatch.previousPid,
          timeoutMs: 20,
        });
        yield* persistServerRuntimeState({
          path: file,
          state: {
            version: 1,
            pid: mismatch.pid,
            port: 3774,
            host: "127.0.0.1",
            origin: "http://127.0.0.1:3774",
            startedAt: mismatch.startedAt ?? DateTime.formatIso(yield* DateTime.now),
          },
        });
        assert.equal((yield* ready.awaitReady.pipe(Effect.flip)).reason, "timeout");
      }
    }),
  );
});
