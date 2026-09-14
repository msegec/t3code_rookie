import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";

import {
  parseOpenCodeUsageRow,
  readOpenCodeUsage,
  resolveOpenCodeDatabasePaths,
} from "./usageOpenCode.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const windows = { sinceTimeMs: 1000, untilTimeMs: 2000 };
const fixture = Effect.fn("fixture")(function* (current = false, withoutRowid = false) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-usage-" });
  const file = path.join(root, "opencode.db");
  const database = new NodeSqlite.DatabaseSync(file);
  const table = current ? "session_message" : "message";
  database.exec(
    `CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER${current ? ", type TEXT" : ""})${withoutRowid ? " WITHOUT ROWID" : ""}`,
  );
  const insert = (id: string, data: unknown = assistant(), updated = 999999) =>
    database
      .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?${current ? ", 'assistant'" : ""})`)
      .run(id, "session", typeof data === "string" ? data : encodeJson(data), updated);
  return { root, file, database, insert };
});
function assistant(completed: number | null = 1500) {
  return {
    role: "assistant",
    time: { completed },
    providerID: "test",
    modelID: "unknown",
    model: { providerID: "test", id: "unknown" },
    tokens: { input: 10, output: 5, reasoning: 9, cache: { read: 3, write: 2 } },
    cost: 0,
  };
}

describe("OpenCode usage", () => {
  it.live("reports cancellation for an empty database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database } = yield* fixture();
      database.close();
      expect(
        yield* Effect.promise(() =>
          readOpenCodeUsage(file, fileSystem, { ...windows, signal: AbortSignal.abort() }),
        ),
      ).toMatchObject({ status: "partial", message: "OpenCode scan cancelled.", records: [] });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("converts disjoint native tokens and preserves zero cost on an unknown model", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture();
      insert("one");
      database.close();
      const result = yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows));
      expect(result).toMatchObject({
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
      });
      expect(result.records).toEqual([
        {
          provider: "opencode",
          timestampMs: 1500,
          model: "test/unknown",
          sessionId: "session",
          reportedCostUsd: 0,
          dedupeKey: "opencode:one",
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 3,
            cacheCreationTokens: 2,
            outputTokens: 14,
            reasoningTokens: 9,
          },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("keeps absent cost unpriced and excludes unfinished and zero-token placeholders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture(true);
      const { cost: _, ...noCost } = assistant();
      insert("absent", noCost);
      insert("unfinished", assistant(null));
      insert("empty", { ...assistant(), tokens: {} });
      database.close();
      const result = yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows));
      expect(result.status).toBe("ok");
      expect(result.records.map((record) => record.reportedCostUsd)).toEqual([null]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("prefers the current snapshot, even when it no longer belongs to the window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture(true);
      insert("one");
      insert("moved", assistant(2100));
      database.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER)",
      );
      const legacy = database.prepare("INSERT INTO message VALUES (?, 'session', ?, 1500)");
      legacy.run("one", encodeJson({ ...assistant(), tokens: { input: 999 } }));
      legacy.run("moved", encodeJson(assistant()));
      database.close();
      const result = yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows));
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.totals.uncachedInputTokens).toBe(10);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live(
    "applies exact inclusive lower and exclusive upper bounds independently of late edits",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { file, database, insert } = yield* fixture(false, true);
        const since = Date.parse("2026-11-01T01:00:00-04:00");
        const until = Date.parse("2026-11-01T01:00:00-05:00");
        for (const timestamp of [since - 1, since, until - 1, until])
          insert(String(timestamp), assistant(timestamp), until + 999999);
        database.close();
        const result = yield* Effect.promise(() =>
          readOpenCodeUsage(file, fileSystem, {
            sinceTimeMs: since,
            untilTimeMs: until,
          }),
        );
        expect(result.records.map((record) => record.timestampMs)).toEqual([since, until - 1]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("counts malformed and oversized rows only in the examined region", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture();
      insert("good");
      insert("invalid", "{");
      insert("huge", "x".repeat(1_048_577));
      insert("wrong-tokens", { ...assistant(), tokens: { input: "10" } });
      database.close();
      const result = yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows));
      expect(result).toMatchObject({ status: "partial", malformedRecords: 3 });
      expect(result.records).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("reads changed snapshots from the WAL without relying on database mtime", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture();
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      insert("one");
      expect(
        (yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows))).records[0]
          ?.totals.uncachedInputTokens,
      ).toBe(10);
      database
        .prepare("UPDATE message SET data = ? WHERE id = 'one'")
        .run(encodeJson({ ...assistant(), tokens: { input: 20 } }));
      expect(
        (yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows))).records[0]
          ?.totals.uncachedInputTokens,
      ).toBe(20);
      database.close();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("yields and honours cancellation between raw pages with sparse matching history", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database, insert } = yield* fixture();
      database.exec("BEGIN");
      for (let index = 0; index < 5000; index++)
        insert(String(index), index === 0 ? assistant() : "{");
      database.exec("COMMIT");
      database.close();
      const { pending } = yield* Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const pending = readOpenCodeUsage(file, fileSystem, { ...windows, signal });
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        return { pending };
      }).pipe(Effect.scoped);
      const result = yield* Effect.promise(() => pending);
      expect(result.status).toBe("partial");
      expect(result.message).toContain("cancelled");
      expect(result.malformedRecords).toBeLessThanOrEqual(255);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("bounds raw work in a large nonmatching history and lets the event loop run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database } = yield* fixture();
      database.exec(
        `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<100500) INSERT INTO message SELECT CAST(n AS TEXT), 's', '{', 0 FROM rows`,
      );
      database.close();
      let turns = 0;
      let turn = setImmediate(function countTurn() {
        turns++;
        turn = setImmediate(countTurn);
      });
      const result = yield* Effect.promise(() =>
        readOpenCodeUsage(file, fileSystem, windows).finally(() => clearImmediate(turn)),
      );
      expect(result.status).toBe("partial");
      expect(result.message).toMatch(/limit|budget/);
      expect(result.malformedRecords).toBeGreaterThan(0);
      expect(result.malformedRecords).toBeLessThanOrEqual(100000);
      expect(turns).toBeGreaterThan(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("reports missing, locked and unknown-schema stores explicitly", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, file, database } = yield* fixture();
      expect(
        yield* Effect.promise(() =>
          readOpenCodeUsage(path.join(root, "missing.db"), fileSystem, windows),
        ),
      ).toMatchObject({
        status: "missing",
        scannedFiles: 0,
        skippedFiles: 1,
      });
      database.exec("BEGIN EXCLUSIVE");
      expect(
        yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows)),
      ).toMatchObject({
        status: "failed",
        message: "OpenCode database is locked.",
      });
      database.exec("ROLLBACK; DROP TABLE message");
      database.close();
      expect(
        yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows)),
      ).toMatchObject({
        status: "failed",
        message: "OpenCode history has an unknown schema.",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("rejects unsupported schema and nonfinite projected metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { file, database } = yield* fixture();
      database.exec("DROP TABLE message; CREATE TABLE message (id TEXT, data TEXT)");
      database.close();
      expect(
        (yield* Effect.promise(() => readOpenCodeUsage(file, fileSystem, windows))).status,
      ).toBe("failed");
      expect(
        parseOpenCodeUsageRow({
          messageId: "a",
          sessionId: "s",
          timestampMs: Infinity,
          providerId: "p",
          modelId: "m",
          inputTokens: 1,
        }),
      ).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("OpenCode discovery", () => {
  it.live("reports discovery bounds and keeps account environments independent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, database } = yield* fixture();
      database.close();
      const directory = path.join(root, ".local/share/opencode");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* Effect.all(
        Array.from({ length: 40 }, (_, index) =>
          fileSystem.writeFileString(path.join(directory, `opencode-channel${index}.db`), ""),
        ),
      );
      const result = yield* Effect.promise(() =>
        resolveOpenCodeDatabasePaths({
          fileSystem,
          path,
          environment: {},
          homeDir: root,
          cwd: root,
        }),
      );
      expect(result.partial).toBe(true);
      expect(result.paths).toHaveLength(32);
      const account = yield* Effect.promise(() =>
        resolveOpenCodeDatabasePaths({
          fileSystem,
          path,
          environment: { OPENCODE_DB: "account2.db" },
          homeDir: root,
          cwd: root,
        }),
      );
      expect(account).toEqual({ paths: [path.join(directory, "account2.db")], partial: false });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("resolves relative overrides, configured data roots and in-memory storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = {
        fileSystem,
        path,
        environment: { XDG_DATA_HOME: "data", OPENCODE_DB: "account.db" },
        homeDir: "/home/example",
        cwd: "/workspace",
      };
      expect((yield* Effect.promise(() => resolveOpenCodeDatabasePaths(input))).paths).toEqual([
        "/workspace/data/opencode/account.db",
      ]);
      expect(
        yield* Effect.promise(() =>
          resolveOpenCodeDatabasePaths({ ...input, environment: { OPENCODE_DB: ":memory:" } }),
        ),
      ).toEqual({ paths: [], partial: true });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live(
    "discovers channel databases, honours channel disabling, and canonicalises shared homes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, database } = yield* fixture();
        database.close();
        const data = path.join(root, "data");
        yield* fileSystem.makeDirectory(path.join(data, "opencode"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(data, "opencode/opencode.db"), "");
        yield* fileSystem.writeFileString(path.join(data, "opencode/opencode-preview.db"), "");
        yield* fileSystem.writeFileString(path.join(data, "opencode/irrelevant.db"), "");
        yield* fileSystem.symlink(
          path.join(data, "opencode/opencode.db"),
          path.join(data, "opencode/opencode-shared.db"),
        );
        const input = {
          fileSystem,
          path,
          environment: { XDG_DATA_HOME: data },
          homeDir: root,
          cwd: root,
        };
        expect((yield* Effect.promise(() => resolveOpenCodeDatabasePaths(input))).paths).toEqual([
          path.join(data, "opencode/opencode-preview.db"),
          path.join(data, "opencode/opencode.db"),
        ]);
        expect(
          (yield* Effect.promise(() =>
            resolveOpenCodeDatabasePaths({
              ...input,
              environment: { ...input.environment, OPENCODE_DISABLE_CHANNEL_DB: "true" },
            }),
          )).paths,
        ).toEqual([path.join(data, "opencode/opencode.db")]);
        expect(
          (yield* Effect.promise(() =>
            resolveOpenCodeDatabasePaths({
              ...input,
              environment: { ...input.environment, OPENCODE_DB: "opencode-shared.db" },
            }),
          )).paths,
        ).toEqual([path.join(data, "opencode/opencode.db")]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
