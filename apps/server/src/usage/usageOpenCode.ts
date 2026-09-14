import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageRecord } from "./usageTranscripts.ts";

type OpenCodeRecord = Omit<UsageRecord, "provider"> & {
  readonly provider: "opencode";
  readonly dedupeKey: string;
};
const PAGE_ROWS = 256;
const MAX_ROWS = 100_000;
const MAX_SCAN_MS = 2_000;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_DATABASES = 32;
const BUN_SQLITE_MODULE: string = "bun:sqlite";

type SqlValue = string | number;
interface Database {
  prepare(sql: string): { all(...parameters: SqlValue[]): unknown[] };
  close(): void;
}

export async function resolveOpenCodeDatabasePaths({
  environment,
  homeDir,
  cwd,
}: {
  environment: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  cwd: string;
}): Promise<{ paths: readonly string[]; partial: boolean }> {
  const dataDirectory = NodePath.resolve(
    cwd,
    environment.XDG_DATA_HOME || NodePath.join(homeDir, ".local/share"),
    "opencode",
  );
  const override = environment.OPENCODE_DB?.trim();
  if (override === ":memory:") return { paths: [], partial: true };
  let partial = false;
  let paths = [NodePath.resolve(dataDirectory, override || "opencode.db")];
  if (
    !override &&
    !["1", "true"].includes(environment.OPENCODE_DISABLE_CHANNEL_DB?.trim().toLowerCase() ?? "")
  ) {
    try {
      const directory = await NodeFSP.opendir(dataDirectory);
      let examined = 0;
      for await (const entry of directory) {
        if (/^opencode-[a-zA-Z0-9._-]+\.db$/.test(entry.name))
          paths.push(NodePath.join(dataDirectory, entry.name));
        if (++examined >= 4096 || paths.length >= MAX_DATABASES) {
          partial = true;
          break;
        }
      }
    } catch (error) {
      partial = object(error)?.code !== "ENOENT";
      paths = [NodePath.join(dataDirectory, "opencode.db")];
    }
  }
  return {
    paths: [
      ...new Set(
        await Promise.all(paths.map(async (file) => NodeFSP.realpath(file).catch(() => file))),
      ),
    ].sort(),
    partial,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseOpenCodeUsageRow(value: unknown): OpenCodeRecord | null {
  const row = object(value);
  if (
    !row ||
    typeof row.messageId !== "string" ||
    !row.messageId ||
    typeof row.sessionId !== "string" ||
    !row.sessionId ||
    typeof row.timestampMs !== "number" ||
    !Number.isFinite(row.timestampMs) ||
    typeof row.providerId !== "string" ||
    !row.providerId ||
    typeof row.modelId !== "string" ||
    !row.modelId
  )
    return null;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
  ]) {
    if (
      row[key] !== null &&
      row[key] !== undefined &&
      (typeof row[key] !== "number" || !Number.isFinite(row[key]))
    )
      return null;
  }
  const reasoningTokens = nonNegativeInt(row.reasoningTokens);
  const totals = {
    uncachedInputTokens: nonNegativeInt(row.inputTokens),
    cachedInputTokens: nonNegativeInt(row.cacheReadTokens),
    cacheCreationTokens: nonNegativeInt(row.cacheWriteTokens),
    outputTokens: nonNegativeInt(row.outputTokens) + reasoningTokens,
    reasoningTokens,
  };
  if (
    Object.values(totals).every((count) => count === 0) ||
    Object.values(totals).some((count) => !Number.isSafeInteger(count))
  )
    return null;
  return {
    provider: "opencode",
    timestampMs: Math.trunc(row.timestampMs),
    model: `${row.providerId}/${row.modelId}`,
    sessionId: row.sessionId,
    totals,
    reportedCostUsd: typeof row.costUsd === "number" && row.costUsd >= 0 ? row.costUsd : null,
    dedupeKey: `opencode:${row.messageId}`,
  };
}

async function openDatabase(databasePath: string): Promise<Database> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await import(BUN_SQLITE_MODULE)) as {
      Database: new (
        file: string,
        options: { readonly: boolean; create: boolean },
      ) => { run(sql: string): unknown; query: Database["prepare"]; close(): void };
    };
    const database = new Database(databasePath, { readonly: true, create: false });
    try {
      database.run("PRAGMA busy_timeout = 50");
    } catch (error) {
      database.close();
      throw error;
    }
    return {
      prepare: (sql) => ({ all: (...parameters) => database.query(sql).all(...parameters) }),
      close: () => database.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(databasePath, { readOnly: true, timeout: 50 });
}

export async function readOpenCodeUsage(
  databasePath: string,
  options: {
    sinceTimeMs: number;
    untilTimeMs: number;
    signal?: AbortSignal;
  },
): Promise<{
  records: readonly OpenCodeRecord[];
  status: "ok" | "missing" | "partial" | "failed";
  scannedFiles: number;
  skippedFiles: number;
  malformedRecords: number;
  message: string | null;
}> {
  const records = new Map<string, OpenCodeRecord>();
  const seen = new Set<string>();
  let database: Database | undefined;
  let malformedRecords = 0;
  let scannedFiles = 0;
  let examined = 0;
  let status: "ok" | "missing" | "partial" | "failed" = "ok";
  let message: string | null = null;
  const started = performance.now();
  const stopReason = () =>
    options.signal?.aborted
      ? "OpenCode scan cancelled."
      : examined >= MAX_ROWS
        ? "OpenCode scan reached the 100000-row limit."
        : performance.now() - started >= MAX_SCAN_MS
          ? "OpenCode scan reached the 2-second budget."
          : null;
  try {
    if (databasePath === ":memory:") throw new Error("OpenCode in-memory history is unavailable.");
    await NodeFSP.stat(databasePath);
    database = await openDatabase(databasePath);
    const tables = database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message') LIMIT 2",
      )
      .all()
      .map(object);
    if (!tables.length) throw new Error("OpenCode history has an unknown schema.");
    scannedFiles = 1;
    scan: for (const table of ["session_message", "message"]) {
      const schema = tables.find((row) => row?.name === table);
      if (!schema) continue;
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(object);
      if (
        !["id", "session_id", "data", ...(table === "session_message" ? ["type"] : [])].every(
          (name) => columns.some((column) => column?.name === name),
        )
      )
        throw new Error("OpenCode history has an unknown schema.");
      const withoutRowid = typeof schema.sql === "string" && /WITHOUT\s+ROWID/i.test(schema.sql);
      const primary = columns.filter((column) => typeof column?.pk === "number" && column.pk > 0);
      if (withoutRowid && (primary.length !== 1 || primary[0]?.name !== "id"))
        throw new Error("OpenCode history has an unsupported primary key.");
      const key = withoutRowid
        ? "id"
        : ["rowid", "_rowid_", "oid"].find(
            (name) => !columns.some((column) => column?.name === name),
          );
      if (!key) throw new Error("OpenCode history has no supported paging key.");
      const high = object(
        database
          .prepare(`SELECT ${key} AS scanKey FROM ${table} ORDER BY ${key} DESC LIMIT 1`)
          .all()[0],
      )?.scanKey;
      if (high === undefined) continue;
      if (typeof high !== "string" && typeof high !== "number")
        throw new Error("OpenCode history has an unsupported paging key.");
      let cursor: SqlValue | undefined;
      while (true) {
        message = stopReason();
        if (message) {
          status = "partial";
          break scan;
        }
        const limit = Math.min(PAGE_ROWS, MAX_ROWS - examined);
        const current = table === "session_message";
        const sql = `WITH page AS MATERIALIZED (
          SELECT ${key} AS scanKey, id, session_id, ${current ? "type" : "NULL"} AS kind,
            CASE WHEN length(CAST(data AS BLOB)) <= ${MAX_RECORD_BYTES} THEN data END AS boundedData
          FROM ${table} WHERE ${cursor === undefined ? "" : `${key} > ? AND `}${key} <= ? ORDER BY ${key} LIMIT ?
        ), valid AS MATERIALIZED (
          SELECT *, CASE WHEN json_valid(boundedData) THEN boundedData END AS safeData FROM page
        ) SELECT scanKey, id AS messageId, session_id AS sessionId,
          boundedData IS NULL AS oversized, safeData IS NULL AS invalid,
          ${current ? "kind" : "json_extract(safeData, '$.role')"} AS role,
          json_extract(safeData, '$.time.completed') AS timestampMs,
          json_extract(safeData, '${current ? "$.model.providerID" : "$.providerID"}') AS providerId,
          json_extract(safeData, '${current ? "$.model.id" : "$.modelID"}') AS modelId,
          json_extract(safeData, '$.tokens.input') AS inputTokens,
          json_extract(safeData, '$.tokens.output') AS outputTokens,
          json_extract(safeData, '$.tokens.reasoning') AS reasoningTokens,
          json_extract(safeData, '$.tokens.cache.read') AS cacheReadTokens,
          json_extract(safeData, '$.tokens.cache.write') AS cacheWriteTokens,
          json_extract(safeData, '$.cost') AS costUsd FROM valid ORDER BY scanKey`;
        const rows = database
          .prepare(sql)
          .all(...(cursor === undefined ? [high, limit] : [cursor, high, limit]));
        for (const value of rows) {
          examined++;
          const row = object(value);
          if (!row || (typeof row.scanKey !== "number" && typeof row.scanKey !== "string"))
            throw new Error("OpenCode history has an unsupported paging key.");
          cursor = row.scanKey;
          if (typeof row.messageId === "string") {
            if (seen.has(row.messageId)) continue;
            seen.add(row.messageId);
          }
          if (row.invalid || row.oversized) {
            malformedRecords++;
            continue;
          }
          if (row.role !== "assistant" || row.timestampMs === null) continue;
          if (typeof row.timestampMs !== "number" || !Number.isFinite(row.timestampMs)) {
            malformedRecords++;
            continue;
          }
          if (row.timestampMs < options.sinceTimeMs || row.timestampMs >= options.untilTimeMs)
            continue;
          const record = parseOpenCodeUsageRow(row);
          if (record) records.set(record.dedupeKey, record);
          else if (
            [
              row.inputTokens,
              row.outputTokens,
              row.reasoningTokens,
              row.cacheReadTokens,
              row.cacheWriteTokens,
            ].some((count) => count !== null && count !== 0)
          )
            malformedRecords++;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (rows.length < limit || cursor === high) break;
      }
    }
    if (options.signal?.aborted && status === "ok") {
      status = "partial";
      message = "OpenCode scan cancelled.";
    }
    if (malformedRecords && status === "ok") {
      status = "partial";
      message = "OpenCode history contains malformed or oversized records in the examined rows.";
    }
  } catch (error) {
    const code = object(error)?.code;
    status = code === "ENOENT" ? "missing" : records.size ? "partial" : "failed";
    message =
      code === "ENOENT"
        ? "OpenCode database is missing."
        : code === "EACCES" || code === "EPERM"
          ? "OpenCode database access was denied."
          : error instanceof Error && /locked|busy/i.test(error.message)
            ? "OpenCode database is locked."
            : error instanceof Error && error.message.startsWith("OpenCode ")
              ? error.message
              : "OpenCode database could not be read.";
  } finally {
    try {
      database?.close();
    } catch {
      status = "partial";
      message = "OpenCode database handle could not be closed.";
    }
  }
  return {
    records: [...records.values()],
    status,
    scannedFiles,
    skippedFiles: scannedFiles ? 0 : 1,
    malformedRecords,
    message,
  };
}
