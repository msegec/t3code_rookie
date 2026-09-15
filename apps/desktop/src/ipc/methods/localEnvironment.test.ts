import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { getLocalEnvironmentEnabled, setLocalEnvironmentEnabled } from "./localEnvironment.ts";

// `relaunch` declares the lifecycle runtime services as requirements even
// though the mocked relaunch never touches them.
const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/disposable",
    platform: "darwin",
    processArch: "x64",
    appVersion: "0.0.17",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: "/disposable", T3CODE_PORT: "3773" }),
      ),
    ),
  ),
  Layer.mock(DesktopWindow.DesktopWindow, {}),
  Layer.mock(ElectronApp.ElectronApp, {}),
  Layer.mock(ElectronTheme.ElectronTheme, {}),
);

describe("local environment IPC", () => {
  it.effect("relaunches only when the setting changes and keeps other settings", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, {
        relaunch: (reason) =>
          Effect.sync(() => {
            relaunchReasons.push(reason);
          }),
      }),
      unusedLifecycleRuntimeLayer,
    );
    return Effect.gen(function* () {
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.isFalse(yield* getLocalEnvironmentEnabled.handler());
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.deepEqual(relaunchReasons, ["localEnvironmentEnabled=false"]);

      yield* setLocalEnvironmentEnabled.handler(true);
      assert.isTrue(yield* getLocalEnvironmentEnabled.handler());
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      assert.isTrue((yield* appSettings.get).wslBackendEnabled);
      assert.deepEqual(relaunchReasons, [
        "localEnvironmentEnabled=false",
        "localEnvironmentEnabled=true",
      ]);
    }).pipe(Effect.provide(layer));
  });
  it.effect("preserves the setting and does not relaunch when persistence fails", () => {
    let relaunched = false;
    const failure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/disposable/desktop-settings.json",
      cause: new Error("permission denied"),
    });
    const layer = Layer.mergeAll(
      Layer.mock(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        setLocalEnvironmentEnabled: () => Effect.fail(failure),
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, {
        relaunch: () =>
          Effect.sync(() => {
            relaunched = true;
          }),
      }),
      unusedLifecycleRuntimeLayer,
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(setLocalEnvironmentEnabled.handler(false));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure, failure);
      assert.isTrue(yield* getLocalEnvironmentEnabled.handler());
      assert.isFalse(relaunched);
    }).pipe(Effect.provide(layer));
  });
});
