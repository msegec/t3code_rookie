import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates local backend ownership", () => {
  for (const localEnvironmentEnabled of [false, true]) {
    for (const failure of ["throw", "event"] as const) {
      it.effect(
        `recovers ${failure} install failure with local backend enabled=${localEnvironmentEnabled}`,
        () => {
          const harness = makeHarness({
            beforeSetUpdateChannel: Effect.void,
            quitAndInstall:
              failure === "throw"
                ? Effect.fail(
                    new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                      channel: "latest",
                      isSilent: true,
                      isForceRunAfter: true,
                      cause: new Error("installer refused"),
                    }),
                  )
                : Effect.void,
          });
          const layer = Layer.effect(DesktopUpdates.DesktopUpdates, DesktopUpdates.make).pipe(
            Layer.provideMerge(
              Layer.merge(
                harness.layer,
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  localEnvironmentEnabled,
                }),
              ),
            ),
          );

          return Effect.scoped(
            Effect.gen(function* () {
              const updates = yield* DesktopUpdates.DesktopUpdates;
              const desktopState = yield* DesktopState.DesktopState;
              yield* updates.configure;
              harness.emit("update-downloaded", { version: "1.2.4" });
              yield* flushCallbacks;

              const result = yield* updates.install;
              assert.isTrue(result.accepted);
              if (failure === "event") {
                harness.emit("error", new Error("native installer refused"));
                yield* flushCallbacks;
              }

              assert.isFalse(yield* Ref.get(desktopState.quitting));
              assert.equal((yield* updates.getState).errorContext, "install");
              assert.deepEqual(
                harness.installSteps,
                localEnvironmentEnabled ? ["quitAndInstall", "startBackend"] : ["quitAndInstall"],
              );
              assert.equal((yield* updates.setChannel("nightly")).channel, "nightly");
            }),
          ).pipe(Effect.provide(Layer.merge(TestClock.layer(), layer)));
        },
      );
    }
  }
});
