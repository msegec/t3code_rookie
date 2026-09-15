import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, it as plainIt } from "vite-plus/test";

import {
  BundleNotSelfContainedError,
  packWindowsServerAsar,
  resolveDesktopUpdateChannel,
  resolveHostFfiBindings,
  resolveStageAllowBuilds,
  validateWindowsPackagedPayload,
  WINDOWS_SERVER_ASAR_RESOURCE,
} from "./build-desktop-artifact.ts";

describe("fleet desktop artifact", () => {
  plainIt("keeps MZS fleet builds on the nightly channel", () => {
    assert.equal(
      resolveDesktopUpdateChannel("0.0.34-nightly.20260824.1172.mzs.r1234abcdef56"),
      "nightly",
    );
  });

  plainIt("keeps install scripts only for a stage that matches the host", () => {
    const allowBuilds = { electron: true, "node-pty": true, "msgpackr-extract": true };
    assert.deepStrictEqual(
      resolveStageAllowBuilds(allowBuilds, {
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      allowBuilds,
    );
    for (const stage of [
      { platform: "mac", arch: "x64" },
      { platform: "win", arch: "arm64" },
      { platform: "linux", arch: "arm64" },
    ] as const) {
      assert.deepStrictEqual(
        resolveStageAllowBuilds(allowBuilds, { ...stage, hostPlatform: "linux", hostArch: "x64" }),
        { electron: true, "node-pty": false, "msgpackr-extract": false },
      );
    }
  });
});

// A Windows sidecar probed on a Linux build host: the bundle imports ffi-rs,
// whose loader wants the host binding the sidecar does not ship.
const makeCrossHostFixture = Effect.fn("test.makeCrossHostFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-cross-host-" });

  const sourceDir = path.join(tempDir, "server-source");
  yield* fs.makeDirectory(path.join(sourceDir, "apps/server/dist"), { recursive: true });
  yield* fs.makeDirectory(path.join(sourceDir, "node_modules/ffi-rs"), { recursive: true });
  yield* fs.writeFileString(
    path.join(sourceDir, "apps/server/dist/bin.mjs"),
    'import "ffi-rs";\nconsole.log("server");\n',
  );
  yield* fs.writeFileString(
    path.join(sourceDir, "node_modules/ffi-rs/package.json"),
    '{"name":"ffi-rs","version":"0.0.0","main":"index.js"}',
  );
  yield* fs.writeFileString(
    path.join(sourceDir, "node_modules/ffi-rs/index.js"),
    'require("@yuuang/ffi-rs-host-binding");\n',
  );
  yield* fs.writeFileString(path.join(sourceDir, "node_modules/ffi-rs/win32.node"), "native");
  const asarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(asarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  yield* fs.copy(
    `${asarPath}.unpacked`,
    path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
  );
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  yield* fs.writeFileString(path.join(packagedAppDir, "t3code.exe"), "electron");

  // The build tree's ffi-rs install, laid out the way pnpm places the host
  // binding as a sibling of the package it belongs to.
  const repoRoot = path.join(tempDir, "repo");
  const storeDir = path.join(repoRoot, "node_modules/.pnpm/ffi-rs@0.0.0/node_modules");
  const bindingDir = path.join(storeDir, "@yuuang/ffi-rs-host-binding");
  yield* fs.makeDirectory(path.join(storeDir, "ffi-rs"), { recursive: true });
  yield* fs.makeDirectory(bindingDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(bindingDir, "package.json"),
    '{"name":"@yuuang/ffi-rs-host-binding","version":"0.0.0","main":"index.js"}',
  );
  yield* fs.writeFileString(path.join(bindingDir, "index.js"), "module.exports = {};\n");
  yield* fs.makeDirectory(path.join(repoRoot, "apps/desktop/node_modules"), { recursive: true });
  yield* fs.symlink(
    path.join(storeDir, "ffi-rs"),
    path.join(repoRoot, "apps/desktop/node_modules/ffi-rs"),
  );

  return { stageDistDir, repoRoot } as const;
});

it.layer(NodeServices.layer)("fleet cross-host Windows sidecar probe", (it) => {
  it.effect("resolves the host ffi-rs bindings from the build tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeCrossHostFixture();
        const bindings = yield* resolveHostFfiBindings(fixture.repoRoot);
        assert.deepEqual(
          bindings.map((binding) => binding.name),
          ["@yuuang/ffi-rs-host-binding"],
        );
      }),
    ),
  );

  it.effect("probes a Windows sidecar on a Linux host with the host binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeCrossHostFixture();
        const withoutBinding = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: "t3code.exe",
          targetArch: "x64",
          appVersion: "1.2.3",
        }).pipe(Effect.flip);
        assert.instanceOf(withoutBinding, BundleNotSelfContainedError);
        assert.include(withoutBinding.output, "@yuuang/ffi-rs-host-binding");

        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: "t3code.exe",
          targetArch: "x64",
          appVersion: "1.2.3",
          repoRoot: fixture.repoRoot,
        });
        assert.deepEqual(result.unpackedFiles, ["node_modules/ffi-rs/win32.node"]);
      }),
    ).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
});
