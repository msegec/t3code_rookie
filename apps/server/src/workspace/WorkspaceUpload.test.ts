// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PROJECT_UPLOAD_URL_TTL_MS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import {
  WORKSPACE_UPLOAD_ROUTE_PREFIX,
  issueWorkspaceUploadUrl,
  storeWorkspaceUpload,
  validateWorkspaceUploadToken,
} from "./WorkspaceUpload.ts";

const testLayer = Layer.empty.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-upload-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempWorkspaceRoot = Effect.fn("makeTempWorkspaceRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-upload-",
  });
});

function tokenFromRelativeUrl(relativeUrl: string): string {
  return relativeUrl.slice(`${WORKSPACE_UPLOAD_ROUTE_PREFIX}/`.length);
}

const AttachmentUploadClaimsForTest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const encodeAttachmentUploadClaimsForTest = Schema.encodeSync(
  Schema.fromJsonString(AttachmentUploadClaimsForTest),
);

describe("WorkspaceUpload", () => {
  it.effect("mints, validates, and stores an upload roundtrip", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3, 4]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "sub/dir/file.bin",
        sizeBytes: bytes.byteLength,
      });
      expect(issued.relativePath).toBe("sub/dir/file.bin");

      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath: "sub/dir/file.bin" });

      const finalPath = NodePath.join(cwd, "sub/dir/file.bin");
      expect(NodeFS.existsSync(finalPath)).toBe(true);
      expect(NodeFS.readFileSync(finalPath)).toEqual(Buffer.from(bytes));
      const siblingEntries = NodeFS.readdirSync(NodePath.dirname(finalPath));
      expect(siblingEntries.some((entry) => entry.endsWith(".part"))).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a mint target that escapes the workspace root", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();

      const error = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "../outside.txt",
        sizeBytes: 3,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProjectCreateUploadUrlError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects mint on an existing file without overwrite, allows it with overwrite", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(NodePath.join(cwd, "existing.txt"), "old");

      const rejected = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "existing.txt",
        sizeBytes: 3,
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("ProjectUploadTargetExistsError");

      const bytes = new Uint8Array([9, 9, 9]);
      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "existing.txt",
        sizeBytes: bytes.byteLength,
        overwrite: true,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath: "existing.txt" });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "existing.txt"))).toEqual(Buffer.from(bytes));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a store body whose size does not match the claims", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "file.bin",
        sizeBytes: 4,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, new Uint8Array([1, 2, 3]));
      expect(result).toMatchObject({ ok: false, status: 400 });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a store when the target appeared after mint without overwrite", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = new Uint8Array([5, 6, 7]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "race.txt",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      yield* fileSystem.writeFileString(NodePath.join(cwd, "race.txt"), "raced");

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toMatchObject({ ok: false, status: 409 });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered, malformed, expired, and cross-kind tokens", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "file.bin",
        sizeBytes: 3,
      });
      const token = tokenFromRelativeUrl(issued.relativeUrl);
      const [payload, signature] = token.split(".");

      expect(yield* validateWorkspaceUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateWorkspaceUploadToken("garbage")).toBeNull();

      yield* TestClock.adjust(PROJECT_UPLOAD_URL_TTL_MS + 1);
      expect(yield* validateWorkspaceUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an attachment-upload token presented to the workspace validator", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const secret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
      const nowMs = yield* Clock.currentTimeMillis;
      const encodedPayload = base64UrlEncode(
        encodeAttachmentUploadClaimsForTest({
          version: 1,
          kind: "attachment-upload",
          attachmentId: "pending-00000000-0000-4000-8000-000000000000",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 3,
          expiresAt: nowMs + 60_000,
        }),
      );
      const token = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

      expect(yield* validateWorkspaceUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
});
