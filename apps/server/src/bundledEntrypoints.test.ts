import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../package.json" with { type: "json" };

const run = Effect.fn("bundledEntrypoints.run")(
  function* (command: ChildProcess.StandardCommand) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    return yield* Effect.all(
      {
        status: child.exitCode,
        stdout: child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
        stderr: child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
      },
      { concurrency: "unbounded" },
    );
  },
  Effect.scoped,
  Effect.timeout("60 seconds"),
);

it.effect("bundled CLI and service launcher run only their own entrypoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverDir = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const outputDir = yield* fs.makeTempDirectoryScoped({
      directory: serverDir,
      prefix: ".entrypoint-test-",
    });
    for (const entry of ["bin", "service-launcher"]) {
      const build = yield* run(
        ChildProcess.make("vp", ["pack", `src/${entry}.ts`, "--out-dir", outputDir, "--no-clean"], {
          cwd: serverDir,
        }),
      );
      expect(Number(build.status), build.stdout + build.stderr).toBe(0);
    }
    const env = {
      ...process.env,
      T3CODE_HOME: undefined,
      HOME: path.join(outputDir, "home"),
      XDG_CONFIG_HOME: path.join(outputDir, "config"),
      XDG_DATA_HOME: path.join(outputDir, "data"),
    };
    for (const flag of ["--version", "--help"]) {
      const result = yield* run(
        ChildProcess.make(process.execPath, [path.join(outputDir, "bin.mjs"), flag], {
          env,
          extendEnv: false,
        }),
      );
      expect(Number(result.status), result.stdout + result.stderr).toBe(0);
      expect(result.stderr).not.toContain("[service-launcher]");
      expect(result.stdout).toContain(flag === "--version" ? packageJson.version : "USAGE");
    }
    const launcher = yield* run(
      ChildProcess.make(process.execPath, [path.join(outputDir, "service-launcher.mjs")], {
        env,
        extendEnv: false,
      }),
    );
    expect(Number(launcher.status)).toBe(1);
    expect(launcher.stderr).toContain("[service-launcher] T3CODE_HOME is required");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
