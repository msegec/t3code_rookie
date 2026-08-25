// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_UPLOAD_URL_TTL_MS,
  ProjectCreateUploadUrlError,
  ProjectUploadTargetExistsError,
  type ProjectCreateUploadUrlInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

export const WORKSPACE_UPLOAD_ROUTE_PREFIX = "/api/workspace/upload";

// Asset download, attachment upload, and workspace upload tokens share this
// key; the signed claim kind keeps the token spaces separate.
const SIGNING_SECRET_NAME = "asset-access-signing-key";

const WorkspaceUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace-upload"),
  cwd: Schema.String,
  relativePath: Schema.String,
  sizeBytes: Schema.Number,
  overwrite: Schema.Boolean,
  expiresAt: Schema.Number,
});
export type WorkspaceUploadClaims = typeof WorkspaceUploadClaims.Type;

const workspaceUploadClaimsJson = Schema.fromJsonString(WorkspaceUploadClaims);
const decodeWorkspaceUploadClaims = Schema.decodeUnknownOption(workspaceUploadClaimsJson);
const encodeWorkspaceUploadClaims = Schema.encodeSync(workspaceUploadClaimsJson);

function decodeClaims(encodedPayload: string): WorkspaceUploadClaims | null {
  try {
    return Option.getOrNull(decodeWorkspaceUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueWorkspaceUploadUrl = Effect.fn("WorkspaceUpload.issueUrl")(function* (
  input: ProjectCreateUploadUrlInput,
) {
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError(
      (cause) =>
        new ProjectCreateUploadUrlError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          stage: "signing-key",
          cause,
        }),
    ),
  );

  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const target = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new ProjectCreateUploadUrlError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            stage: "resolve-path",
            cause: error,
          }),
      ),
    );

  const fileSystem = yield* FileSystem.FileSystem;
  const targetExists = yield* fileSystem.exists(target.absolutePath).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectCreateUploadUrlError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          stage: "target-check",
          cause,
        }),
    ),
  );
  if (targetExists) {
    const targetInfo = yield* fileSystem.stat(target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectCreateUploadUrlError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            stage: "target-check",
            cause,
          }),
      ),
    );
    if (targetInfo.type !== "File") {
      return yield* new ProjectCreateUploadUrlError({
        cwd: input.cwd,
        relativePath: target.relativePath,
        stage: "target-not-file",
      });
    }
    if (input.overwrite !== true) {
      return yield* new ProjectUploadTargetExistsError({
        cwd: input.cwd,
        relativePath: target.relativePath,
      });
    }
  }

  const nowMs = yield* Clock.currentTimeMillis;
  const expiresAt = nowMs + PROJECT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeWorkspaceUploadClaims({
      version: 1,
      kind: "workspace-upload",
      cwd: input.cwd,
      relativePath: target.relativePath,
      sizeBytes: input.sizeBytes,
      overwrite: input.overwrite === true,
      expiresAt,
    }),
  );

  return {
    relativePath: target.relativePath,
    relativeUrl: `${WORKSPACE_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt,
  };
});

export const validateWorkspaceUploadToken = Effect.fn("WorkspaceUpload.validateToken")(function* (
  token: string,
) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) {
    return null;
  }

  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the workspace upload signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
    return null;
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return null;
  }
  return claims;
});

export type StoreWorkspaceUploadResult =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const storeWorkspaceUpload = Effect.fn("WorkspaceUpload.store")(function* (
  claims: WorkspaceUploadClaims,
  bytes: Uint8Array,
) {
  if (bytes.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${bytes.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreWorkspaceUploadResult;
  }

  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const target = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: claims.cwd,
      relativePath: claims.relativePath,
    })
    .pipe(Effect.catchTags({ WorkspacePathOutsideRootError: () => Effect.succeed(null) }));
  if (!target) {
    return {
      ok: false,
      status: 500,
      detail: "Failed to resolve the workspace upload target.",
    } satisfies StoreWorkspaceUploadResult;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The part file lives beside the target under a fixed-length name so a long
  // target basename cannot push the temporary filename past the 255-byte
  // filesystem component limit.
  const partPath = path.join(path.dirname(target.absolutePath), `.${NodeCrypto.randomUUID()}.part`);
  const escapesWorkspaceRoot = Effect.fn(function* (directory: string) {
    const [canonicalRoot, canonicalDir] = yield* Effect.all([
      fileSystem.realPath(claims.cwd),
      fileSystem.realPath(directory),
    ]);
    const relativeDir = path.relative(canonicalRoot, canonicalDir);
    return (
      relativeDir === ".." ||
      relativeDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDir)
    );
  });
  return yield* Effect.gen(function* () {
    const targetExists = yield* fileSystem.exists(target.absolutePath);
    if (targetExists) {
      const targetInfo = yield* fileSystem.stat(target.absolutePath);
      if (targetInfo.type !== "File") {
        // Overwrite renames the part file onto the target, which must never
        // replace a directory that appeared after the URL was minted.
        return {
          ok: false,
          status: 409,
          detail: "A folder exists at this path.",
        } satisfies StoreWorkspaceUploadResult;
      }
      if (!claims.overwrite) {
        return {
          ok: false,
          status: 409,
          detail: "A file already exists at this path.",
        } satisfies StoreWorkspaceUploadResult;
      }
    }

    // The lexical resolve above cannot see symlinked directory components, and
    // recursive mkdir follows them, so canonically re-check the deepest
    // existing ancestor before creating directories and the final directory
    // before any bytes land, the same way AssetAccess guards signed reads.
    const targetDirectory = path.dirname(target.absolutePath);
    let existingAncestor = targetDirectory;
    while (!(yield* fileSystem.exists(existingAncestor))) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return {
          ok: false,
          status: 500,
          detail: "Failed to resolve the workspace upload target.",
        } satisfies StoreWorkspaceUploadResult;
      }
      existingAncestor = parent;
    }
    if (yield* escapesWorkspaceRoot(existingAncestor)) {
      return {
        ok: false,
        status: 400,
        detail: "Upload path resolves outside the project.",
      } satisfies StoreWorkspaceUploadResult;
    }
    yield* fileSystem.makeDirectory(targetDirectory, { recursive: true });
    if (yield* escapesWorkspaceRoot(targetDirectory)) {
      return {
        ok: false,
        status: 400,
        detail: "Upload path resolves outside the project.",
      } satisfies StoreWorkspaceUploadResult;
    }
    if (claims.overwrite) {
      yield* fileSystem.writeFile(partPath, bytes);
      yield* fileSystem.rename(partPath, target.absolutePath);
    } else {
      // rename replaces a file created after the exists check above; linking
      // the staged part onto the target claims the name atomically instead, so
      // concurrent non-overwrite uploads cannot clobber and a failed write
      // never strands a partial target. FAT and exFAT volumes reject hard
      // links, so those claim the name with an empty O_EXCL create and then
      // rename the part onto their own claim. The failed create removes
      // nothing, so it can never delete a rival's file; only a failed rename
      // reclaims the name, and only while the name still holds the empty
      // claim.
      yield* fileSystem.writeFile(partPath, bytes);
      const claim = yield* fileSystem.link(partPath, target.absolutePath).pipe(
        Effect.as("claimed" as const),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed("conflict" as const),
        ),
        Effect.catch(() => Effect.succeed("unsupported" as const)),
      );
      if (claim === "conflict") {
        return {
          ok: false,
          status: 409,
          detail: "A file already exists at this path.",
        } satisfies StoreWorkspaceUploadResult;
      }
      if (claim === "unsupported") {
        // The claim and the rename onto it form one critical section: an
        // interrupt between them would strand a permanent empty file at the
        // target, so the pair runs uninterruptibly. The failed-rename reclaim
        // checks that the name still holds the empty claim, so a confirmed
        // overwrite landing in between can never have its content deleted.
        const fallback = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const conflict = yield* fileSystem
              .writeFile(target.absolutePath, new Uint8Array(0), { flag: "wx" })
              .pipe(
                Effect.as(false),
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.succeed(true),
                ),
              );
            if (conflict) {
              return "conflict" as const;
            }
            // A rival's confirmed overwrite could legitimately be zero bytes,
            // so size alone cannot identify the claim; the reclaim also
            // requires the inode captured at claim time, and falls back to
            // the size check only where the platform reports no inode.
            const claimInode = yield* fileSystem.stat(target.absolutePath).pipe(
              Effect.map((info) => Option.getOrNull(info.ino)),
              // A stat failure here would strand the empty claim as a
              // permanent conflict. With no inode to identify the claim by,
              // the reclaim re-stats and removes only a zero-byte file, so a
              // rival's non-empty overwrite is never deleted; when the fault
              // persists the claim stays, trading a retryable conflict for
              // zero data loss.
              Effect.tapError(() =>
                fileSystem.stat(target.absolutePath).pipe(
                  Effect.flatMap((info) =>
                    info.size === FileSystem.Size(0)
                      ? fileSystem.remove(target.absolutePath, { force: true })
                      : Effect.void,
                  ),
                  Effect.ignore,
                ),
              ),
            );
            yield* fileSystem.rename(partPath, target.absolutePath).pipe(
              Effect.tapError(() =>
                fileSystem.stat(target.absolutePath).pipe(
                  Effect.flatMap((info) =>
                    info.size === FileSystem.Size(0) && Option.getOrNull(info.ino) === claimInode
                      ? fileSystem.remove(target.absolutePath, { force: true })
                      : Effect.void,
                  ),
                  Effect.ignore,
                ),
              ),
            );
            return "stored" as const;
          }),
        );
        if (fallback === "conflict") {
          return {
            ok: false,
            status: 409,
            detail: "A file already exists at this path.",
          } satisfies StoreWorkspaceUploadResult;
        }
      }
    }

    // The link path leaves the part behind on purpose; reclaim it before the
    // refresh so the rebuilt index never lists a phantom part entry. The
    // rename paths already consumed it, making this a no-op there.
    yield* fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore);
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    yield* workspaceEntries.refresh(claims.cwd);

    return { ok: true, relativePath: target.relativePath } satisfies StoreWorkspaceUploadResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to persist workspace upload.", {
        cwd: claims.cwd,
        relativePath: claims.relativePath,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        } satisfies StoreWorkspaceUploadResult),
      ),
    ),
    // Effect.catch does not run on fiber interruption, so the part file is
    // reclaimed here on every exit, including a client that drops mid-upload.
    Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)),
  );
});
