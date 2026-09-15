import { ConnectionTargetStore, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";

const { discover, bootstrap } = vi.hoisted(() => ({ discover: vi.fn(), bootstrap: vi.fn() }));
vi.mock("@t3tools/client-runtime/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/environment")>()),
  fetchRemoteEnvironmentDescriptor: discover,
}));
vi.mock("@t3tools/client-runtime/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/authorization")>()),
  bootstrapRemoteBearerSession: bootstrap,
}));
vi.mock("./storage", async () => {
  const Layer = await import("effect/Layer");
  return {
    connectionStorageLayer: Layer.succeed(
      ConnectionTargetStore,
      ConnectionTargetStore.of({
        list: Effect.succeed([
          new BearerConnectionTarget({
            environmentId: EnvironmentId.make("saved-remote"),
            connectionId: "saved-remote-connection",
            label: "Saved remote",
          }),
        ]),
        listDisabled: Effect.succeed([]),
      }),
    ),
  };
});

import { connectionPlatformLayer } from "./platform";

function installDesktop(enabled?: boolean) {
  const topology = vi.fn(() => [
    {
      id: "primary",
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    },
  ]);
  vi.stubGlobal("window", {
    location: new URL(enabled === false ? "t3code://app/" : "http://127.0.0.1:3773/"),
    desktopBridge: {
      ...(enabled === undefined ? {} : { getLocalEnvironmentEnabled: () => enabled }),
      getLocalEnvironmentBootstraps: topology,
    },
  });
  vi.stubGlobal("navigator", { userAgent: "test", platform: "Linux", maxTouchPoints: 0 });
  return topology;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("client-only platform discovery", () => {
  it.effect("skips primary discovery and auth while exposing saved remote targets", () =>
    Effect.gen(function* () {
      const topology = installDesktop(false);
      const result = yield* Effect.gen(function* () {
        const platform = yield* PlatformConnectionSource;
        const saved = yield* ConnectionTargetStore;
        return {
          platform: yield* Stream.runCollect(platform.registrations),
          saved: yield* saved.list,
        };
      }).pipe(Effect.provide(connectionPlatformLayer));

      expect(Array.from(result.platform)).toEqual([]);
      expect(result.saved.map((target) => target.environmentId)).toEqual(["saved-remote"]);
      expect(topology).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
    }),
  );

  for (const enabled of [true, undefined]) {
    it.effect(`discovers the primary when the setting is ${enabled}`, () =>
      Effect.gen(function* () {
        installDesktop(enabled);
        discover.mockReturnValue(
          Effect.succeed({
            environmentId: EnvironmentId.make("primary-environment"),
            label: "Primary",
          }),
        );
        const registrations = yield* Effect.gen(function* () {
          const platform = yield* PlatformConnectionSource;
          return yield* platform.registrations.pipe(Stream.take(1), Stream.runCollect);
        }).pipe(Effect.provide(connectionPlatformLayer));

        expect(Array.from(registrations)).toMatchObject([
          [{ target: { environmentId: "primary-environment" } }],
        ]);
        expect(discover).toHaveBeenCalledOnce();
        expect(bootstrap).not.toHaveBeenCalled();
      }),
    );
  }
});
