// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// This file is shipped as a standalone bundle and copied to a stable path by
// `t3 service update`. Keep runtime imports limited to Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import type {
  ManualServerHandoff,
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";
import type { PersistedServerRuntimeState } from "./serverRuntimeState.ts";

const HANDOFF_DELAY_MS = 2_000;
const PREPARED_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

/** SQLite persists across the main file plus its WAL and shared-memory sidecars. */
const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

// Opened read-write: Windows refuses to flush a handle without write access.
async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Flushes a directory entry so a rename into it survives power loss. Windows
// has no directory fsync: the handle opens but sync fails with EPERM, and
// NTFS journals the rename on its own.
async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Snapshots the database once per update before the first trial. A completed
 * backup is never overwritten because a restarted launcher may be looking at
 * database writes from an earlier attempt by the same trial.
 */
async function backupDatabaseOnce(baseDir: string, pending: PendingServiceUpdate): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await NodeFSP.copyFile(source, destination);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

/** Mark rollback before changing live files so launcher recovery cannot boot a partial restore. */
async function markDatabaseRestorePending(backupDir: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, RESTORE_MARKER);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

/** Restore is retryable after any process crash while the backup directory remains. */
async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);
  for (const suffix of DB_FILE_SUFFIXES) {
    const target = `${pending.dbPath}${suffix}`;
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      await NodeFSP.copyFile(source, target);
      await syncFile(target);
    } else {
      await NodeFSP.rm(target, { force: true });
    }
  }
  await syncDirectory(NodePath.dirname(pending.dbPath));
}

async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

/** Durable same-directory replacement used for every runtime state transition. */
export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);

async function hasProcessIdentity(): Promise<boolean> {
  try {
    await NodeFSP.access("/proc/self/stat");
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (!(await hasProcessIdentity())) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return undefined;
      throw cause;
    }
    throw new Error(
      "Automatic replacement of a manual server requires Linux process ownership verification. Stop the manual server before installing the service on this platform.",
    );
  }
  try {
    const stat = await NodeFSP.stat(`/proc/${pid}`);
    if (stat.uid !== process.getuid?.()) throw new Error("Manual server belongs to another user.");
    const contents = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/.test(startTime))
      throw new Error("Cannot verify manual server process identity.");
    return startTime;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function verifyStandaloneServer(pid: number): Promise<void> {
  const args = (await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  const entry = args[1];
  if (entry === undefined || !entry.endsWith("/t3/dist/bin.mjs")) {
    throw new Error("Automatic replacement requires a standalone installed T3 server.");
  }
  const command = args[2];
  if (command !== undefined && command !== "" && command !== "serve" && !command.startsWith("--")) {
    throw new Error("The recorded process is not a T3 server command.");
  }
}

async function ownsDatabase(pid: number, dbPath: string): Promise<boolean> {
  const database = await NodeFSP.stat(dbPath);
  const handles = await NodeFSP.readdir(`/proc/${pid}/fd`);
  if (handles.length > 65536)
    throw new Error("Too many process handles to verify replacement safely.");
  for (const handle of handles) {
    try {
      const file = await NodeFSP.stat(`/proc/${pid}/fd/${handle}`);
      if (file.dev === database.dev && file.ino === database.ino) return true;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
  return false;
}

export async function recordedProcessOwnsDatabase(pid: number, dbPath: string): Promise<boolean> {
  if (!(await hasProcessIdentity())) return true;
  try {
    return await ownsDatabase(pid, dbPath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export async function readServerNetworkSettings(
  runtime: PersistedServerRuntimeState,
  dbPath: string,
  managed = false,
) {
  if (runtime.tailscaleServeEnabled !== undefined && runtime.tailscaleServePort !== undefined) {
    return {
      tailscaleServeEnabled: runtime.tailscaleServeEnabled,
      tailscaleServePort: runtime.tailscaleServePort,
    };
  }
  if (!(await hasProcessIdentity())) {
    if (!managed) await processIdentity(runtime.pid);
    return undefined;
  }
  const identity = await processIdentity(runtime.pid);
  if (identity === undefined || !(await recordedProcessOwnsDatabase(runtime.pid, dbPath)))
    return undefined;
  const args = (await NodeFSP.readFile(`/proc/${runtime.pid}/cmdline`, "utf8")).split("\0");
  const environment = (await NodeFSP.readFile(`/proc/${runtime.pid}/environ`, "utf8")).split("\0");
  const env = (name: string) =>
    environment.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const flag = (name: string) => {
    const index = args.findIndex((entry) => entry === name || entry.startsWith(`${name}=`));
    if (index < 0) return undefined;
    const argument = args[index];
    if (argument === undefined) return undefined;
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    const next = args[index + 1];
    return next === undefined || next === "" || next.startsWith("--") ? "true" : next;
  };
  if (flag("--bootstrap-fd") !== undefined || env("T3CODE_BOOTSTRAP_FD") !== undefined) {
    throw new Error(
      "Cannot preserve legacy bootstrap network settings. Stop the server before installing the service.",
    );
  }
  const enabled = args.includes("--no-tailscale-serve")
    ? "false"
    : (flag("--tailscale-serve") ?? env("T3CODE_TAILSCALE_SERVE") ?? "false");
  const port = Number(
    flag("--tailscale-serve-port") ?? env("T3CODE_TAILSCALE_SERVE_PORT") ?? "443",
  );
  if (
    !["true", "false", "yes", "no", "on", "off", "1", "0", "y", "n"].includes(enabled) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Cannot preserve the server's Tailscale Serve settings.");
  }
  if ((await processIdentity(runtime.pid)) !== identity)
    throw new Error("Server changed while reading network settings.");
  return {
    tailscaleServeEnabled: ["true", "yes", "on", "1", "y"].includes(enabled),
    tailscaleServePort: port,
  };
}

export async function captureManualServerHandoff(
  pid: number,
  dbPath: string,
): Promise<ManualServerHandoff | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid manual server PID.");
  const startTime = await processIdentity(pid);
  if (startTime === undefined) return undefined;
  try {
    await verifyStandaloneServer(pid);
    if (!(await ownsDatabase(pid, dbPath)))
      throw new Error("Manual server does not own the expected database.");
    const verified = await processIdentity(pid);
    if (verified === undefined) return undefined;
    if (verified !== startTime)
      throw new Error("Manual server identity changed during verification.");
  } catch (cause) {
    if ((await processIdentity(pid)) === undefined) return undefined;
    throw cause;
  }
  return { pid, startTime, dbPath };
}

export async function completeManualServerHandoff(handoff: ManualServerHandoff): Promise<void> {
  if (handoff.pid === process.pid) throw new Error("The service launcher cannot replace itself.");
  const current = await processIdentity(handoff.pid);
  if (current === undefined) return;
  if (current !== handoff.startTime)
    throw new Error("Manual server PID was reused; refusing replacement.");
  const verified = await captureManualServerHandoff(handoff.pid, handoff.dbPath);
  if (verified === undefined) return;
  if (verified.startTime !== handoff.startTime)
    throw new Error("Manual server identity changed before shutdown.");
  try {
    process.kill(handoff.pid, "SIGTERM");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
  }
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if ((await processIdentity(handoff.pid)) !== handoff.startTime) return;
    await NodeTimersPromises.setTimeout(50);
  }
  throw new Error(
    "Manual server did not exit after graceful shutdown; replacement was not started.",
  );
}

export async function verifyDatabaseOwner(
  dbPath: string,
  expectedPid: number | undefined,
): Promise<void> {
  if (!(await hasProcessIdentity())) return;
  try {
    await NodeFSP.stat(dbPath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
  const entries = await NodeFSP.readdir("/proc");
  if (entries.length > 65536) throw new Error("Too many processes to verify replacement safely.");
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      if ((await NodeFSP.stat(`/proc/${pid}`)).uid !== process.getuid?.()) continue;
      const commandLine = await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!/t3|T3/.test(commandLine)) continue;
      if ((await ownsDatabase(pid, dbPath)) && pid !== expectedPid) {
        throw new Error(
          `Another process (PID ${pid}) has ${dbPath} open; resolve the conflicting instance before updating.`,
        );
      }
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
}

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  readonly #completion = Promise.withResolvers<void>();

  constructor(baseDir: string, state: ServiceState) {
    this.#baseDir = baseDir;
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      this.#enqueue(() => this.#recover());
      await this.#completion.promise;
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await terminateChild(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // This must happen synchronously at signal receipt. A queued update
    // transition may already be terminating the active child, and that child
    // needs to see the marker in its shutdown finalizer. KillMode=mixed also
    // ensures systemd signals the launcher before the rest of the cgroup, and
    // launchd signals only the job's main process (this launcher), so the
    // marker lands before the child sees any signal on both platforms.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {
      // Err toward keeping the tunnel; the next link or unlink reconciles it.
    }
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let an update transition already in progress start its replacement
      // before this queued stop tears it down. That replacement owns the
      // pre-activation tunnel cleanup path and observes the marker above.
      this.#stopping = true;
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await terminateChild(child, signal);
      this.#done = true;
      this.#completion.resolve();
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #recover(): Promise<void> {
    if (this.#state.handoff !== undefined) {
      if (
        NodePath.resolve(this.#state.handoff.dbPath) !==
        NodePath.resolve(this.#baseDir, "userdata", "state.sqlite")
      ) {
        throw new Error("Manual server handoff does not match this service database.");
      }
      await completeManualServerHandoff(this.#state.handoff);
      const { handoff: _handoff, ...next } = this.#state;
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    }
    // A fresh launcher means servers are running again: any stop marker from
    // a previous explicit stop is stale and must not make a future update
    // handoff release its tunnel.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      await this.#startChild(this.#state.activeVersion, "active", update);
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      return;
    }
    await this.#startTrial(update);
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    // The previous child is dead here, so all three SQLite files are quiescent.
    try {
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(update === undefined ? {} : { update }),
    };
    const endpoint = this.#state.endpoint;
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        paths.entryPath,
        "serve",
        ...(endpoint === undefined
          ? []
          : [
              "--port",
              String(endpoint.port),
              ...(endpoint.host === undefined ? [] : ["--host", endpoint.host]),
            ]),
      ],
      {
        env: {
          ...process.env,
          ...(endpoint?.tailscaleServeEnabled === undefined
            ? {}
            : { T3CODE_TAILSCALE_SERVE: String(endpoint.tailscaleServeEnabled) }),
          ...(endpoint?.tailscaleServePort === undefined
            ? {}
            : { T3CODE_TAILSCALE_SERVE_PORT: String(endpoint.tailscaleServePort) }),
          [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
        },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#enqueue(() => Promise.reject(error)));
        resolve();
      });
    });
    if (this.#stopping) {
      await terminateChild(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    await this.#handlePrepared(child, message.updateId);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactServiceVersions(message.targetVersion, child.version) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, update: pending };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    this.#child = null;
    await terminateChild(child.process);
    await this.#startTrial(pending);
  }

  async #handlePrepared(child: ManagedChild, updateId: string): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    child.role = "active";
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    await sendMessage(child.process, { type: "committed", updateId: committed.id });
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await terminateChild(child.process);
    }
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    await this.#startChild(next.activeVersion, "active", outcome);
  }
}

export async function runServiceLauncher(): Promise<void> {
  const baseDir = process.env.T3CODE_HOME?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const state = await readServiceState(statePath);
  await new Launcher(baseDir, state).run();
}

type ServerReadinessReceipt =
  | { readonly state: PersistedServerRuntimeState }
  | { readonly reason: "watch" | "read" | "timeout"; readonly cause?: unknown };

interface ServerReadinessWatchInput {
  readonly startedAt: number;
  readonly path: string;
  readonly endpoint: { readonly port: number; readonly host?: string };
  readonly previousPid?: number;
  readonly timeoutMs?: number;
  readonly decode: (raw: string) => PersistedServerRuntimeState;
}

export function startServerReadinessWatch(input: ServerReadinessWatchInput) {
  let settled = false;
  let checking = false;
  let changed = false;
  const { promise: result, resolve: finish } = Promise.withResolvers<ServerReadinessReceipt>();
  const settle = (value: ServerReadinessReceipt) => {
    if (settled) return;
    settled = true;
    void close().then(() => finish(value));
  };
  const check = async () => {
    changed = true;
    if (checking || settled) return;
    checking = true;
    try {
      while (changed) {
        if (settled) return;
        changed = false;
        let raw: string;
        try {
          raw = await NodeFSP.readFile(input.path, "utf8");
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
          settle({ reason: "read", cause });
          return;
        }
        let state: PersistedServerRuntimeState;
        try {
          state = input.decode(raw);
        } catch {
          continue;
        }
        if (
          state.pid <= 1 ||
          !Number.isSafeInteger(state.pid) ||
          !(Date.parse(state.startedAt) >= input.startedAt) ||
          state.pid === input.previousPid ||
          state.port !== input.endpoint.port ||
          state.host !== input.endpoint.host ||
          state.devUrl !== undefined
        )
          continue;
        try {
          process.kill(state.pid, 0);
        } catch {
          continue;
        }
        settle({ state });
      }
    } finally {
      checking = false;
    }
  };
  const watcher = NodeFS.watch(NodePath.dirname(input.path), (_event, filename) => {
    if (filename === null || filename === NodePath.basename(input.path)) void check();
  });
  watcher.on("error", (cause) => settle({ reason: "watch", cause }));
  const timer = setTimeout(() => settle({ reason: "timeout" }), input.timeoutMs ?? 60_000);
  const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
  const close = () => {
    settled = true;
    clearTimeout(timer);
    watcher.close();
    return closed;
  };
  void check();
  return { result, close };
}
