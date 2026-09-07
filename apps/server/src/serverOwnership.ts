import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeRuntimeSqliteLayer } from "./persistence/Layers/Sqlite.ts";
import { recordedProcessOwnsDatabase } from "./serviceLauncher.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

export class ServerOwnershipError extends Schema.TaggedError<ServerOwnershipError>()(
  "ServerOwnershipError",
  { dbPath: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Cannot start another T3 server for ${this.dbPath}. ${this.detail}`;
  }
}

export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (config: {
  readonly dbPath: string;
  readonly serverRuntimeStatePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(config.dbPath), { recursive: true });
  const directory = yield* fs.realPath(path.dirname(config.dbPath));
  const dbPath = (yield* fs.exists(config.dbPath))
    ? yield* fs.realPath(config.dbPath)
    : path.join(directory, path.basename(config.dbPath));
  const context = yield* Layer.build(makeRuntimeSqliteLayer({ filename: `${dbPath}.server-lock` }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* Effect.acquireRelease(
    sql`BEGIN EXCLUSIVE`.pipe(
      Effect.mapError(
        (cause) =>
          new ServerOwnershipError({
            dbPath,
            detail:
              "Another server owns this database, or its ownership lock could not be acquired. Stop the existing instance before restarting.",
            cause,
          }),
      ),
    ),
    () => sql`ROLLBACK`.pipe(Effect.orDie),
  );
  const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (
    Option.isSome(runtime) &&
    runtime.value.ownership !== "exclusive" &&
    isProcessAlive(runtime.value.pid) &&
    (yield* fs.exists(dbPath)) &&
    (yield* Effect.tryPromise({
      try: () => recordedProcessOwnsDatabase(runtime.value.pid, dbPath),
      catch: (cause) =>
        new ServerOwnershipError({
          dbPath,
          detail: "Cannot verify the recorded server database owner.",
          cause,
        }),
    }))
  ) {
    return yield* new ServerOwnershipError({
      dbPath,
      detail: `Server PID ${runtime.value.pid} is already running at ${runtime.value.origin}. Update or stop that instance before restarting.`,
    });
  }
});
