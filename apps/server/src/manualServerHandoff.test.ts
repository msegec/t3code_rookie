// @effect-diagnostics nodeBuiltinImport:off - spies on the Node promise API the handoff reads /proc through.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect, vi } from "vite-plus/test";

import { decodeManualServerHandoff, SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import {
  captureManualServerHandoff,
  readServerNetworkSettings,
  completeManualServerHandoff,
  verifyDatabaseOwner,
  Launcher,
  readServiceState,
  writeServiceState,
} from "./serviceLauncher.ts";

const procAvailability = vi.hoisted(() => ({ missing: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    access: async (...args: Parameters<typeof original.access>) => {
      if (procAvailability.missing && args[0] === "/proc/self/stat")
        throw Object.assign(new Error("No proc filesystem"), { code: "ENOENT" });
      return original.access(...args);
    },
  };
});

it("keeps legacy managed network overrides absent without Linux process inspection", async () => {
  procAvailability.missing = true;
  const runtime = {
    version: 1 as const,
    pid: process.pid,
    port: 3774,
    origin: "http://127.0.0.1:3774",
    startedAt: "2026-09-07T00:00:00.000Z",
  };
  try {
    expect(await readServerNetworkSettings(runtime, "/unused", true)).toBeUndefined();
    await expect(readServerNetworkSettings(runtime, "/unused", false)).rejects.toThrow(
      "requires Linux",
    );
  } finally {
    procAvailability.missing = false;
  }
});

const makeServer = (
  ignoreTermination = false,
  args: ReadonlyArray<string> = [],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-" });
    const entry = `${root}/node_modules/t3/dist/bin.mjs`;
    const dbPath = `${root}/userdata/state.sqlite`;
    yield* fs.makeDirectory(`${root}/node_modules/t3/dist`, { recursive: true });
    yield* fs.makeDirectory(`${root}/userdata`, { recursive: true });
    yield* fs.writeFileString(dbPath, "fixture");
    yield* fs.writeFileString(
      entry,
      `import * as fs from 'node:fs'; const fd=fs.openSync(process.argv[3],'r'); process.on('SIGTERM',()=>{${ignoreTermination ? "" : "fs.closeSync(fd);process.exit(0)"}}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`,
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [entry, "serve", dbPath, ...args], {
        killSignal: "SIGKILL",
        ...(env === undefined ? {} : { env }),
      }),
    );
    const ready = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.take(1),
      Stream.runCollect,
    );
    expect(ready).toEqual(["ready"]);
    const supported = yield* fs.exists("/proc/self/stat");
    if (!supported) {
      yield* Effect.promise(() =>
        expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow("requires Linux"),
      );
      expect(yield* child.isRunning).toBe(true);
    }
    return { child, dbPath, root, fs, supported };
  });

it.layer(NodeServices.layer)("manual server handoff", (it) => {
  it.effect("verifies archive executable identity before handing off its database", () =>
    Effect.gen(function* () {
      const { child, dbPath, root, supported } = yield* makeServer();
      if (!supported) return;
      yield* Effect.promise(async () => {
        await NodeFSP.symlink(process.execPath, `${root}/t3`);
        await NodeFSP.mkdir(`${root}/unrelated`);
        await NodeFSP.symlink(dbPath, `${root}/unrelated/t3`);
      });
      let searchPath = `/missing-handoff-executable:${root}`;
      const originalReadFile = NodeFSP.readFile;
      const originalReadlink = NodeFSP.readlink;
      let command = "serve";
      let executableName = "/archive/t3";
      let executable = `/proc/${child.pid}/exe`;
      const readFile = vi
        .spyOn(NodeFSP, "readFile")
        .mockImplementation((...args) =>
          args[0] === `/proc/${child.pid}/cmdline`
            ? Promise.resolve(`${executable}\0${command}\0`)
            : args[0] === `/proc/${child.pid}/environ`
              ? Promise.resolve(`PATH=${searchPath}\0`)
              : originalReadFile(...args),
        );
      const readlink = vi
        .spyOn(NodeFSP, "readlink")
        .mockImplementation((...args) =>
          args[0] === `/proc/${child.pid}/exe`
            ? Promise.resolve(executableName)
            : originalReadlink(...args),
        );
      try {
        const handoff = yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath));
        expect(handoff?.pid).toBe(child.pid);
        executable = "t3";
        expect(
          (yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath)))?.pid,
        ).toBe(child.pid);
        searchPath = `${root}/unrelated:${root}`;
        yield* Effect.promise(() =>
          expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow(
            "standalone installed",
          ),
        );
        searchPath = Array.from({ length: 257 }, () => root).join(":");
        yield* Effect.promise(() =>
          expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow(
            "Too many executable paths",
          ),
        );
        searchPath = `/missing-handoff-executable:${root}`;
        command = "service";
        yield* Effect.promise(() =>
          expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow("not a T3 server"),
        );
        command = "serve";
        executableName = "/archive/node";
        yield* Effect.promise(() =>
          expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow(
            "standalone installed",
          ),
        );
        executableName = "/archive/t3";
        executable = dbPath;
        yield* Effect.promise(() =>
          expect(captureManualServerHandoff(child.pid, dbPath)).rejects.toThrow(
            "standalone installed",
          ),
        );
        expect(yield* child.isRunning).toBe(true);
        executable = `/proc/${child.pid}/exe`;
        if (handoff === undefined) throw new Error("Missing owner");
        yield* Effect.promise(() => completeManualServerHandoff(handoff));
      } finally {
        readFile.mockRestore();
        readlink.mockRestore();
      }
    }),
  );

  it.effect("captures a legacy server's explicit Tailscale endpoint without stopping it", () =>
    Effect.gen(function* () {
      const { child, dbPath, supported } = yield* makeServer(false, [
        "--tailscale-serve",
        "--tailscale-serve-port",
        "8443",
      ]);
      if (!supported) return;
      const settings = yield* Effect.promise(() =>
        readServerNetworkSettings(
          {
            version: 1,
            pid: child.pid,
            port: 3774,
            origin: "http://127.0.0.1:3774",
            startedAt: "2026-09-07T00:00:00.000Z",
          },
          dbPath,
        ),
      );
      expect(settings).toEqual({ tailscaleServeEnabled: true, tailscaleServePort: 8443 });
      expect(yield* child.isRunning).toBe(true);
    }),
  );

  it.effect("preserves legacy environment settings and explicit disabling", () =>
    Effect.gen(function* () {
      for (const disabled of [false, true]) {
        const { child, dbPath, supported } = yield* makeServer(
          false,
          disabled ? ["--no-tailscale-serve"] : [],
          { T3CODE_TAILSCALE_SERVE: "true", T3CODE_TAILSCALE_SERVE_PORT: "9443" },
        );
        if (!supported) return;
        const settings = yield* Effect.promise(() =>
          readServerNetworkSettings(
            {
              version: 1,
              pid: child.pid,
              port: 3774,
              origin: "http://127.0.0.1:3774",
              startedAt: "2026-09-07T00:00:00.000Z",
            },
            dbPath,
          ),
        );
        expect(settings).toEqual({ tailscaleServeEnabled: !disabled, tailscaleServePort: 9443 });
        expect(yield* child.isRunning).toBe(true);
      }
    }),
  );

  it.effect("refuses unrecoverable bootstrap settings before stopping a legacy server", () =>
    Effect.gen(function* () {
      const { child, dbPath, supported } = yield* makeServer(false, ["--bootstrap-fd", "3"]);
      if (!supported) return;
      yield* Effect.promise(() =>
        expect(
          readServerNetworkSettings(
            {
              version: 1,
              pid: child.pid,
              port: 3774,
              origin: "http://127.0.0.1:3774",
              startedAt: "2026-09-07T00:00:00.000Z",
            },
            dbPath,
          ),
        ).rejects.toThrow("bootstrap network settings"),
      );
      expect(yield* child.isRunning).toBe(true);
    }),
  );

  it.effect("stops the exact owner and permits replay after exit", () =>
    Effect.gen(function* () {
      const { child, dbPath, supported } = yield* makeServer();
      if (!supported) return;
      const owner = yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath));
      if (owner === undefined) throw new Error("Missing owner");
      yield* Effect.promise(() => verifyDatabaseOwner(dbPath, child.pid));
      yield* Effect.promise(() => completeManualServerHandoff(owner));
      expect(
        yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath)),
      ).toBeUndefined();
      yield* Effect.promise(() => verifyDatabaseOwner(dbPath, undefined));
      yield* Effect.promise(() => completeManualServerHandoff(owner));
    }),
  );

  it.effect("refuses changed identity without signalling the child", () =>
    Effect.gen(function* () {
      const { child, dbPath, supported } = yield* makeServer();
      if (!supported) return;
      const owner = yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath));
      if (owner === undefined) throw new Error("Missing owner");
      yield* Effect.promise(() =>
        expect(completeManualServerHandoff({ ...owner, startTime: "0" })).rejects.toThrow("reused"),
      );
      expect(yield* child.isRunning).toBe(true);
    }),
  );

  it.effect("rejects unexpected database owners before replacement", () =>
    Effect.gen(function* () {
      const { dbPath, supported } = yield* makeServer();
      if (!supported) return;
      yield* Effect.promise(() =>
        expect(verifyDatabaseOwner(dbPath, undefined)).rejects.toThrow("Another process"),
      );
    }),
  );

  it.effect("launcher preserves the endpoint and starts after the manual owner exits", () =>
    Effect.gen(function* () {
      const { child, dbPath, root, fs, supported } = yield* makeServer();
      if (!supported) return;
      const handoff = yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath));
      if (handoff === undefined) throw new Error("Missing owner");
      const versionDir = `${root}/runtime/versions/1.0.0`;
      const receipt = `${root}/replacement.json`;
      yield* fs.makeDirectory(versionDir, { recursive: true });
      yield* fs.writeFileString(`${versionDir}/.install-complete`, "1.0.0");
      yield* fs.writeFileString(
        `${versionDir}/t3`,
        `#!${process.execPath}\nimport * as fs from 'node:fs';let overlap=false;try{process.kill(${child.pid},0);overlap=true}catch{};fs.writeFileSync('${receipt}',JSON.stringify({overlap,args:process.argv.slice(2)}));`,
      );
      yield* fs.chmod(`${versionDir}/t3`, 0o755);
      const statePath = `${root}/runtime/service-state.json`;
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        endpoint: { host: "127.0.0.1", port: 3774 },
        handoff,
      } as const;
      yield* Effect.promise(() => writeServiceState(statePath, state));
      yield* Effect.promise(() =>
        expect(new Launcher(root, state).run()).rejects.toThrow("Active child exited"),
      );
      expect(yield* fs.readFileString(receipt)).toBe(
        '{"overlap":false,"args":["serve","--port","3774","--host","127.0.0.1"]}',
      );
      expect((yield* Effect.promise(() => readServiceState(statePath))).handoff).toBeUndefined();
    }),
  );

  it.effect("timeout keeps the old owner and durable handoff without starting replacement", () =>
    Effect.gen(function* () {
      const { child, dbPath, root, supported } = yield* makeServer(true);
      if (!supported) return;
      const handoff = yield* Effect.promise(() => captureManualServerHandoff(child.pid, dbPath));
      if (handoff === undefined) throw new Error("Missing owner");
      const statePath = `${root}/runtime/service-state.json`;
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        handoff,
      } as const;
      yield* Effect.promise(() => writeServiceState(statePath, state));
      const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
      try {
        yield* Effect.promise(() =>
          expect(new Launcher(root, state).run()).rejects.toThrow("replacement was not started"),
        );
        expect((yield* Effect.promise(() => readServiceState(statePath))).handoff).toEqual(handoff);
        expect(yield* child.isRunning).toBe(true);
      } finally {
        clock.mockRestore();
      }
    }),
  );
});

it("rejects malformed handoff identities before process inspection", () => {
  const valid = { pid: 42, startTime: "100", dbPath: "/tmp/state.sqlite" };
  expect(decodeManualServerHandoff(valid)).toEqual(valid);
  for (const invalid of [
    null,
    { ...valid, pid: 1 },
    { ...valid, pid: 1.5 },
    { ...valid, startTime: "" },
    { ...valid, dbPath: "relative" },
  ]) {
    expect(decodeManualServerHandoff(invalid)).toBeUndefined();
  }
});
