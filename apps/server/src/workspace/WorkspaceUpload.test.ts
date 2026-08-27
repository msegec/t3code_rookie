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
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

  it.effect("rejects a mint whose target is a directory, even with overwrite", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(NodePath.join(cwd, "folder"));

      const error = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "folder",
        sizeBytes: 3,
        overwrite: true,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProjectCreateUploadUrlError");
      expect(error).toMatchObject({ stage: "target-not-file" });
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

  it.effect("stores a streamed body chunk by chunk", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "streamed.bin",
        sizeBytes: 5,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, Stream.fromArray(chunks));
      expect(result).toEqual({ ok: true, relativePath: "streamed.bin" });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "streamed.bin"))).toEqual(
        Buffer.from([1, 2, 3, 4, 5]),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a streamed body that grows past the claimed size", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "oversized.bin",
        sizeBytes: 3,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(
        claims,
        Stream.fromArray([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      );
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(NodeFS.existsSync(NodePath.join(cwd, "oversized.bin"))).toBe(false);
      expect(NodeFS.readdirSync(cwd).some((entry) => entry.endsWith(".part"))).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a streamed body that ends short of the claimed size", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "truncated.bin",
        sizeBytes: 4,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(
        claims,
        Stream.fromArray([new Uint8Array([1, 2, 3])]),
      );
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(NodeFS.existsSync(NodePath.join(cwd, "truncated.bin"))).toBe(false);
      expect(NodeFS.readdirSync(cwd).some((entry) => entry.endsWith(".part"))).toBe(false);
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

  it.effect("rejects a store when a directory appeared at the target after mint", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = new Uint8Array([5, 6, 7]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "raced-folder",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      yield* fileSystem.makeDirectory(NodePath.join(cwd, "raced-folder"));

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(NodeFS.readdirSync(NodePath.join(cwd, "raced-folder"))).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a store whose directory resolves outside the root through a symlink", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const outside = yield* makeTempWorkspaceRoot();
      NodeFS.symlinkSync(outside, NodePath.join(cwd, "linked"));

      const bytes = new Uint8Array([1, 2, 3]);
      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "linked/nested/owned.txt",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(NodeFS.readdirSync(outside)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores a file whose basename approaches the filename length limit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3]);
      const relativePath = `${"a".repeat(230)}.bin`;

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath,
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath });
      expect(NodeFS.readFileSync(NodePath.join(cwd, relativePath))).toEqual(Buffer.from(bytes));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores into an in-root directory whose name starts with dots", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([4, 5, 6]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "..config/file.txt",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath: "..config/file.txt" });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "..config/file.txt"))).toEqual(
        Buffer.from(bytes),
      );
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

  it.effect("reclaims the staging part before the entries refresh", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "probe.bin",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath: "probe.bin" });

      // The refresh rebuilds the search index from disk, so a part still
      // present at refresh time would be indexed as a phantom entry.
      expect(refreshSnapshots.length).toBeGreaterThan(0);
      const seenAtRefresh = refreshSnapshots.flat();
      expect(seenAtRefresh).toContain("probe.bin");
      expect(seenAtRefresh.some((entry) => entry.endsWith(".part"))).toBe(false);
    }).pipe(Effect.provide(refreshProbeTestLayer)),
  );

  it.effect("falls back to an exclusive create when the volume rejects hard links", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([9, 8, 7]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "fat.bin",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: true, relativePath: "fat.bin" });
      expect(linkRejections.length).toBeGreaterThan(0);
      expect(NodeFS.readFileSync(NodePath.join(cwd, "fat.bin"))).toEqual(Buffer.from(bytes));
      const siblingEntries = NodeFS.readdirSync(cwd);
      expect(siblingEntries.some((entry) => entry.endsWith(".part"))).toBe(false);

      const conflicted = yield* storeWorkspaceUpload(claims, bytes);
      expect(conflicted).toEqual({
        ok: false,
        status: 409,
        detail: "A file already exists at this path.",
      });
    }).pipe(Effect.provide(linklessTestLayer)),
  );

  it.effect("reclaims the empty claim when the fallback rename fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3]);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "held.bin",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: false, status: 500, detail: "Failed to persist upload." });
      // The reclaim removed the empty claim, so a retry does not read the
      // name as taken.
      expect(NodeFS.existsSync(NodePath.join(cwd, "held.bin"))).toBe(false);
    }).pipe(Effect.provide(brokenRenameTestLayer)),
  );

  it.effect("keeps a rival's content when the fallback rename fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3]);
      const rival = new Uint8Array([42, 42]);
      rivalBytesOnRename.current = rival;

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "contested.bin",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: false, status: 500, detail: "Failed to persist upload." });
      // A confirmed overwrite that replaced the claim before the failed
      // rename must survive the reclaim.
      expect(NodeFS.readFileSync(NodePath.join(cwd, "contested.bin"))).toEqual(Buffer.from(rival));
    }).pipe(
      Effect.provide(brokenRenameTestLayer),
      Effect.ensuring(
        Effect.sync(() => {
          rivalBytesOnRename.current = null;
        }),
      ),
    ),
  );

  it.effect("keeps a rival's zero-byte overwrite when the fallback rename fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempWorkspaceRoot();
      const bytes = new Uint8Array([1, 2, 3]);
      rivalBytesOnRename.current = new Uint8Array(0);

      const issued = yield* issueWorkspaceUploadUrl({
        cwd,
        relativePath: "emptied.bin",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* validateWorkspaceUploadToken(tokenFromRelativeUrl(issued.relativeUrl));
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const result = yield* storeWorkspaceUpload(claims, bytes);
      expect(result).toEqual({ ok: false, status: 500, detail: "Failed to persist upload." });
      // The rival's file matches the claim's size but not its inode; the
      // reclaim must leave it in place.
      expect(NodeFS.existsSync(NodePath.join(cwd, "emptied.bin"))).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(cwd, "emptied.bin")).byteLength).toBe(0);
    }).pipe(
      Effect.provide(brokenRenameTestLayer),
      Effect.ensuring(
        Effect.sync(() => {
          rivalBytesOnRename.current = null;
        }),
      ),
    ),
  );
});

const refreshSnapshots: Array<Array<string>> = [];
const refreshProbeLayer = Layer.effect(
  WorkspaceEntries.WorkspaceEntries,
  Effect.gen(function* () {
    const real = yield* WorkspaceEntries.WorkspaceEntries;
    return WorkspaceEntries.WorkspaceEntries.of({
      ...real,
      refresh: (cwd) =>
        Effect.sync(() => {
          refreshSnapshots.push(NodeFS.readdirSync(cwd, { recursive: true }) as Array<string>);
        }).pipe(Effect.andThen(real.refresh(cwd))),
    });
  }),
);

const refreshProbeTestLayer = refreshProbeLayer.pipe(Layer.provideMerge(testLayer));

const linkRejections: Array<string> = [];
const linklessFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      link: (fromPath, toPath) => {
        linkRejections.push(toPath);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "link",
            syscall: "link",
            pathOrDescriptor: toPath,
            description: "EPERM: the volume rejects hard links",
          }),
        );
      },
    });
  }),
);

// Simulates a linkless volume whose rename also fails; when rivalBytesOnRename
// holds bytes, the rename first replaces the target with them, standing in for
// a confirmed overwrite landing between the claim and the rename.
const rivalBytesOnRename: { current: Uint8Array | null } = { current: null };
const brokenRenameFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      link: (_fromPath, toPath) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "link",
            syscall: "link",
            pathOrDescriptor: toPath,
            description: "EPERM: the volume rejects hard links",
          }),
        ),
      rename: (_fromPath, toPath) =>
        Effect.sync(() => {
          const rival = rivalBytesOnRename.current;
          if (rival) {
            // A real overwrite renames the rival's staged part onto the
            // target, replacing the inode; remove-then-write reproduces that.
            NodeFS.rmSync(toPath, { force: true });
            NodeFS.writeFileSync(toPath, rival);
          }
        }).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                syscall: "rename",
                pathOrDescriptor: toPath,
                description: "EACCES: rename rejected",
              }),
            ),
          ),
        ),
    });
  }),
);

const brokenRenameTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-upload-test-" })),
  Layer.provideMerge(brokenRenameFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);

const linklessTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-upload-test-" })),
  Layer.provideMerge(linklessFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);
