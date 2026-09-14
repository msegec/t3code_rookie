import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  parseOpenCodeUsageRow,
  readOpenCodeUsage,
  resolveOpenCodeDatabasePaths,
} from "./usageOpenCode.ts";

const roots: string[] = [];
const windows = { sinceTimeMs: 1000, untilTimeMs: 2000 };
async function fixture(current = false, withoutRowid = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
  roots.push(root);
  const file = NodePath.join(root, "opencode.db");
  const database = new NodeSqlite.DatabaseSync(file);
  const table = current ? "session_message" : "message";
  database.exec(
    `CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER${current ? ", type TEXT" : ""})${withoutRowid ? " WITHOUT ROWID" : ""}`,
  );
  const insert = (id: string, data: unknown = assistant(), updated = 999999) =>
    database
      .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?${current ? ", 'assistant'" : ""})`)
      .run(id, "session", typeof data === "string" ? data : JSON.stringify(data), updated);
  return { root, file, database, insert };
}
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
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("OpenCode usage", () => {
  it("reports cancellation for an empty database", async () => {
    const { file, database } = await fixture();
    database.close();
    expect(
      await readOpenCodeUsage(file, { ...windows, signal: AbortSignal.abort() }),
    ).toMatchObject({ status: "partial", message: "OpenCode scan cancelled.", records: [] });
  });
  it("converts disjoint native tokens and preserves zero cost on an unknown model", async () => {
    const { file, database, insert } = await fixture();
    insert("one");
    database.close();
    const result = await readOpenCodeUsage(file, windows);
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
  });
  it("keeps absent cost unpriced and excludes unfinished and zero-token placeholders", async () => {
    const { file, database, insert } = await fixture(true);
    const { cost: _, ...noCost } = assistant();
    insert("absent", noCost);
    insert("unfinished", assistant(null));
    insert("empty", { ...assistant(), tokens: {} });
    database.close();
    const result = await readOpenCodeUsage(file, windows);
    expect(result.status).toBe("ok");
    expect(result.records.map((record) => record.reportedCostUsd)).toEqual([null]);
  });
  it("prefers the current snapshot, even when it no longer belongs to the window", async () => {
    const { file, database, insert } = await fixture(true);
    insert("one");
    insert("moved", assistant(2100));
    database.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER)",
    );
    const legacy = database.prepare("INSERT INTO message VALUES (?, 'session', ?, 1500)");
    legacy.run("one", JSON.stringify({ ...assistant(), tokens: { input: 999 } }));
    legacy.run("moved", JSON.stringify(assistant()));
    database.close();
    const result = await readOpenCodeUsage(file, windows);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.totals.uncachedInputTokens).toBe(10);
  });
  it("applies exact inclusive lower and exclusive upper bounds independently of late edits", async () => {
    const { file, database, insert } = await fixture(false, true);
    const since = Date.parse("2026-11-01T01:00:00-04:00");
    const until = Date.parse("2026-11-01T01:00:00-05:00");
    for (const timestamp of [since - 1, since, until - 1, until])
      insert(String(timestamp), assistant(timestamp), until + 999999);
    database.close();
    const result = await readOpenCodeUsage(file, { sinceTimeMs: since, untilTimeMs: until });
    expect(result.records.map((record) => record.timestampMs)).toEqual([since, until - 1]);
  });
  it("counts malformed and oversized rows only in the examined region", async () => {
    const { file, database, insert } = await fixture();
    insert("good");
    insert("invalid", "{");
    insert("huge", "x".repeat(1_048_577));
    insert("wrong-tokens", { ...assistant(), tokens: { input: "10" } });
    database.close();
    const result = await readOpenCodeUsage(file, windows);
    expect(result).toMatchObject({ status: "partial", malformedRecords: 3 });
    expect(result.records).toHaveLength(1);
  });
  it("reads changed snapshots from the WAL without relying on database mtime", async () => {
    const { file, database, insert } = await fixture();
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    insert("one");
    expect((await readOpenCodeUsage(file, windows)).records[0]?.totals.uncachedInputTokens).toBe(
      10,
    );
    database
      .prepare("UPDATE message SET data = ? WHERE id = 'one'")
      .run(JSON.stringify({ ...assistant(), tokens: { input: 20 } }));
    expect((await readOpenCodeUsage(file, windows)).records[0]?.totals.uncachedInputTokens).toBe(
      20,
    );
    database.close();
  });
  it("yields and honours cancellation between raw pages with sparse matching history", async () => {
    const { file, database, insert } = await fixture();
    database.exec("BEGIN");
    for (let index = 0; index < 5000; index++)
      insert(String(index), index === 0 ? assistant() : "{");
    database.exec("COMMIT");
    database.close();
    const controller = new AbortController();
    const pending = readOpenCodeUsage(file, { ...windows, signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    const result = await pending;
    expect(result.status).toBe("partial");
    expect(result.message).toContain("cancelled");
    expect(result.malformedRecords).toBeLessThanOrEqual(255);
  });
  it("bounds raw work in a large nonmatching history and lets the event loop run", async () => {
    const { file, database } = await fixture();
    database.exec(
      `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<100500) INSERT INTO message SELECT CAST(n AS TEXT), 's', '{', 0 FROM rows`,
    );
    database.close();
    let turns = 0;
    const timer = setInterval(() => turns++, 0);
    const result = await readOpenCodeUsage(file, windows);
    clearInterval(timer);
    expect(result.status).toBe("partial");
    expect(result.message).toMatch(/limit|budget/);
    expect(result.malformedRecords).toBeGreaterThan(0);
    expect(result.malformedRecords).toBeLessThanOrEqual(100000);
    expect(turns).toBeGreaterThan(1);
  });
  it("reports missing, locked and unknown-schema stores explicitly", async () => {
    const { root, file, database } = await fixture();
    expect(await readOpenCodeUsage(NodePath.join(root, "missing.db"), windows)).toMatchObject({
      status: "missing",
      scannedFiles: 0,
      skippedFiles: 1,
    });
    database.exec("BEGIN EXCLUSIVE");
    expect(await readOpenCodeUsage(file, windows)).toMatchObject({
      status: "failed",
      message: "OpenCode database is locked.",
    });
    database.exec("ROLLBACK; DROP TABLE message");
    database.close();
    expect(await readOpenCodeUsage(file, windows)).toMatchObject({
      status: "failed",
      message: "OpenCode history has an unknown schema.",
    });
  });
  it("rejects unsupported schema and nonfinite projected metadata", async () => {
    const { file, database } = await fixture();
    database.exec("DROP TABLE message; CREATE TABLE message (id TEXT, data TEXT)");
    database.close();
    expect((await readOpenCodeUsage(file, windows)).status).toBe("failed");
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
  });
});

describe("OpenCode discovery", () => {
  it("reports discovery bounds and keeps account environments independent", async () => {
    const { root, database } = await fixture();
    database.close();
    const directory = NodePath.join(root, ".local/share/opencode");
    await NodeFSP.mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        NodeFSP.writeFile(NodePath.join(directory, `opencode-channel${index}.db`), ""),
      ),
    );
    const result = await resolveOpenCodeDatabasePaths({
      environment: {},
      homeDir: root,
      cwd: root,
    });
    expect(result.partial).toBe(true);
    expect(result.paths).toHaveLength(32);
    const account = await resolveOpenCodeDatabasePaths({
      environment: { OPENCODE_DB: "account2.db" },
      homeDir: root,
      cwd: root,
    });
    expect(account).toEqual({ paths: [NodePath.join(directory, "account2.db")], partial: false });
  });
  it("resolves relative overrides, configured data roots and in-memory storage", async () => {
    const input = {
      environment: { XDG_DATA_HOME: "data", OPENCODE_DB: "account.db" },
      homeDir: "/home/example",
      cwd: "/workspace",
    };
    expect((await resolveOpenCodeDatabasePaths(input)).paths).toEqual([
      "/workspace/data/opencode/account.db",
    ]);
    expect(
      await resolveOpenCodeDatabasePaths({ ...input, environment: { OPENCODE_DB: ":memory:" } }),
    ).toEqual({ paths: [], partial: true });
  });
  it("discovers channel databases, honours channel disabling, and canonicalises shared homes", async () => {
    const { root, database } = await fixture();
    database.close();
    const data = NodePath.join(root, "data");
    await NodeFSP.mkdir(NodePath.join(data, "opencode"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(data, "opencode/opencode.db"), "");
    await NodeFSP.writeFile(NodePath.join(data, "opencode/opencode-preview.db"), "");
    await NodeFSP.writeFile(NodePath.join(data, "opencode/irrelevant.db"), "");
    await NodeFSP.symlink(
      NodePath.join(data, "opencode/opencode.db"),
      NodePath.join(data, "opencode/opencode-shared.db"),
    );
    const input = { environment: { XDG_DATA_HOME: data }, homeDir: root, cwd: root };
    expect((await resolveOpenCodeDatabasePaths(input)).paths).toEqual([
      NodePath.join(data, "opencode/opencode-preview.db"),
      NodePath.join(data, "opencode/opencode.db"),
    ]);
    expect(
      (
        await resolveOpenCodeDatabasePaths({
          ...input,
          environment: { ...input.environment, OPENCODE_DISABLE_CHANNEL_DB: "true" },
        })
      ).paths,
    ).toEqual([NodePath.join(data, "opencode/opencode.db")]);
    expect(
      (
        await resolveOpenCodeDatabasePaths({
          ...input,
          environment: { ...input.environment, OPENCODE_DB: "opencode-shared.db" },
        })
      ).paths,
    ).toEqual([NodePath.join(data, "opencode/opencode.db")]);
  });
});
