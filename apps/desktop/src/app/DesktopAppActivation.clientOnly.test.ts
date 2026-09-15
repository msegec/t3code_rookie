import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId, type DesktopAppActivationResponse } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

afterEach(() => vi.restoreAllMocks());

describe("desktop activation in client-only mode", () => {
  for (const localEnvironmentEnabled of [false, true]) {
    it.effect(
      `routes local project opens with local environment enabled=${localEnvironmentEnabled}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* HostProcessPlatform;
          const userId = yield* HostProcessUserId;
          const stateDir = yield* fs.makeTempDirectoryScoped();
          const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
            Effect.provide(
              DesktopEnvironment.layer({
                dirname: stateDir,
                homeDirectory: stateDir,
                platform,
                processArch: "x64",
                appVersion: "1.2.3",
                appPath: stateDir,
                isPackaged: true,
                resourcesPath: stateDir,
                runningUnderArm64Translation: false,
              }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: stateDir }))),
            ),
          );
          const target = resolveDesktopAppControlAddress({
            stateDir,
            platform,
            userId,
            tempDir: NodeOS.tmpdir(),
            joinPath: path.join,
          });
          const request = {
            version: 1,
            requestId: "local-project",
            type: "open-workspace",
            workspaceRoot: path.join(stateDir, "project"),
            platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
          };
          const accepted: DesktopAppActivationResponse = {
            version: 1,
            requestId: request.requestId,
            ok: true,
            projectId: ProjectId.make("project"),
            threadId: ThreadId.make("thread"),
          };
          const brokerRequest = vi
            .spyOn(DesktopAppActivationBroker.prototype, "request")
            .mockResolvedValue(accepted);
          const activate = vi.fn();
          const activation = yield* DesktopAppActivation.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(DesktopEnvironment.DesktopEnvironment, { ...environment, stateDir }),
                Layer.mock(DesktopWindow.DesktopWindow, { activate: Effect.sync(activate) }),
                Layer.mock(ElectronWindow.ElectronWindow, { main: Effect.succeed(Option.none()) }),
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  localEnvironmentEnabled,
                }),
              ),
            ),
          );
          yield* activation.start;
          const response = yield* Effect.promise(
            () =>
              new Promise<unknown>((resolve, reject) => {
                const socket = NodeNet.createConnection(target.address);
                socket.setEncoding("utf8");
                let buffer = "";
                socket.once("error", reject);
                socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
                socket.on("data", (chunk) => {
                  buffer += chunk;
                  const newline = buffer.indexOf("\n");
                  if (newline === -1) return;
                  socket.destroy();
                  resolve(JSON.parse(buffer.slice(0, newline)));
                });
              }),
          );
          if (localEnvironmentEnabled) {
            expect(response).toEqual(accepted);
            expect(brokerRequest).toHaveBeenCalledWith(request);
          } else {
            expect(response).toMatchObject({
              version: 1,
              requestId: request.requestId,
              ok: false,
              code: "renderer-unavailable",
              message: expect.stringMatching(
                /local environment.*turned off.*Settings > Connections/i,
              ),
            });
            expect(brokerRequest).not.toHaveBeenCalled();
            expect(activate).toHaveBeenCalledOnce();
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
