import * as DesktopConfig from "./DesktopConfig.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NetService from "@t3tools/shared/Net";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import { bootstrap, stopAllPoolInstances } from "./DesktopApp.ts";

describe("desktop bootstrap", () => {
  for (const enabled of [false, true]) {
    it.effect(`initialises the client with local execution ${enabled}`, () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const record = (event: string) =>
          Effect.sync(() => {
            events.push(event);
          });
        const reconciled = yield* Deferred.make<void>();
        const primary: DesktopBackendPool.DesktopBackendInstance = {
          id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
          label: Effect.succeed("Local"),
          start: record("start"),
          stop: () => record("stop"),
          currentConfig: Effect.succeed(Option.none()),
          snapshot: Effect.die("unused snapshot"),
          waitForReady: () => Effect.die("unused readiness"),
        };
        const layer = Layer.mergeAll(
          DesktopState.layer,
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: enabled,
            wslBackendEnabled: true,
            wslOnly: true,
          }),
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
          Layer.mock(ElectronProtocol.ElectronProtocol, {
            registerDesktopProtocol: (input) => {
              assert.deepEqual(input, {
                scheme: "t3code",
                assetDirectory: "/repo/apps/server/dist/client",
                clerkFrontendApiHostname: undefined,
              });
              return record("protocol");
            },
          }),
          Layer.mock(DesktopWindow.DesktopWindow, {
            createMainIfBackendReady: record("window"),
            showConnectingSplash: record("splash"),
          }),
          Layer.mock(DesktopSnapShot.DesktopSnapShot, { initialize: record("snapshot") }),
          Layer.mock(DesktopAppActivation.DesktopAppActivation, { start: record("activation") }),
          Layer.mock(NetService.NetService, {}),
          Layer.mock(DesktopBackendPool.DesktopBackendPool, {
            primary: record("primary").pipe(Effect.as(primary)),
            list: Effect.succeed([primary]),
          }),
          Layer.mock(DesktopServerExposure.DesktopServerExposure, {
            configureFromSettings: () =>
              record("exposure").pipe(
                Effect.as({
                  mode: "local-only",
                  endpointUrl: null,
                  advertisedHost: null,
                  tailscaleServeEnabled: false,
                  tailscaleServePort: 443,
                }),
              ),
            backendConfig: Effect.succeed({
              port: 3773,
              bindHost: "127.0.0.1",
              httpBaseUrl: new URL("http://127.0.0.1:3773"),
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            }),
          }),
          Layer.mock(DesktopWslBackend.DesktopWslBackend, {
            reconcile: record("wsl").pipe(
              Effect.andThen(Deferred.succeed(reconciled, undefined)),
              Effect.asVoid,
            ),
          }),
        );
        yield* Effect.gen(function* () {
          yield* bootstrap(record("ipc"));
          if (enabled) {
            assert.include(events, "start");
            yield* Deferred.await(reconciled);
          }
          assert.deepEqual(events.slice(0, 4), ["protocol", "ipc", "activation", "snapshot"]);
          assert.deepEqual(
            events.slice(4),
            enabled ? ["primary", "exposure", "splash", "start", "wsl"] : ["window"],
          );
          yield* stopAllPoolInstances();
          assert.equal(events.at(-1), "stop");
          assert.equal(events.filter((event) => event === "stop").length, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
  }
});
