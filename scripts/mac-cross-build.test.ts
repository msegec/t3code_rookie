import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { stageMacIcons, createBuildConfig } from "./build-desktop-artifact.ts";
import { signMacArchiveContents } from "./build-cli-archive.ts";

it.effect("stages the branded PNG for electron-builder's portable ICNS conversion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = path.join(root, "source.png");
    yield* fs.writeFileString(source, "branded image bytes");
    yield* stageMacIcons(root, source);
    assert.equal(yield* fs.readFileString(path.join(root, "icon.png")), "branded image bytes");
    const config = yield* createBuildConfig(
      "mac",
      "zip",
      "0.0.0-preview-test",
      false,
      false,
      undefined,
      undefined,
    );
    assert.deepInclude(config.mac, { icon: "icon.png", target: ["zip"] });
    assert.isTrue(String(config.afterPack).endsWith(path.join("scripts", "sign-macos-adhoc.ts")));
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "linux"),
  ),
);

for (const host of ["linux", "darwin"] as const) {
  it.effect(`signs Mac archive contents ad hoc on ${host}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
          commands.push({ command: command.command, args: command.args });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      );
      yield* signMacArchiveContents({
        repoRoot: root,
        contentDir: root,
        executablePath: path.join(root, "t3"),
      }).pipe(
        Effect.provide(spawner),
        Effect.provideService(HostProcessPlatform, host),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );
      assert.lengthOf(commands, 1);
      assert.equal(commands[0]?.command, host === "linux" ? "rcodesign" : "codesign");
      assert.deepEqual(
        commands[0]?.args,
        host === "linux"
          ? [
              "--config-file",
              "/dev/null",
              "sign",
              "--timestamp-url",
              "none",
              "--entitlements-xml-file",
              path.join(root, "apps/server/resources/cli-entitlements.plist"),
              path.join(root, "t3"),
            ]
          : [
              "--force",
              "--sign",
              "-",
              "--entitlements",
              path.join(root, "apps/server/resources/cli-entitlements.plist"),
              path.join(root, "t3"),
            ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
