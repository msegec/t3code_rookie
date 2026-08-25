// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";

import {
  ProjectDeleteEntryError,
  ProjectRenameEntryError,
  ProjectRenameEntryTargetExistsError,
  type ProjectDeleteEntryInput,
  type ProjectDeleteEntryStage,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectRenameEntryInput,
  type ProjectRenameEntryResult,
  type ProjectRenameEntryStage,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Rename a file to a new name in the same directory.
     *
     * Never overwrites: an existing entry at the new name fails with
     * `ProjectRenameEntryTargetExistsError`. Directories are rejected.
     */
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<
      ProjectRenameEntryResult,
      ProjectRenameEntryError | ProjectRenameEntryTargetExistsError
    >;
    /**
     * Delete a file relative to the workspace root.
     *
     * Deleting an already-missing file succeeds. Directories are rejected.
     */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<void, ProjectDeleteEntryError>;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  // The lexical resolve cannot see symlinked directory components, so rename
  // and delete canonically re-check the entry's parent directory before
  // mutating, the same way storeWorkspaceUpload guards uploads.
  const directoryEscapesWorkspaceRoot = Effect.fn(function* (
    workspaceRoot: string,
    directory: string,
  ) {
    const [canonicalRoot, canonicalDir] = yield* Effect.all([
      fileSystem.realPath(workspaceRoot),
      fileSystem.realPath(directory),
    ]);
    const relativeDir = path.relative(canonicalRoot, canonicalDir);
    return (
      relativeDir === ".." ||
      relativeDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDir)
    );
  });

  // A link conflict can be the source itself seen under another name, either
  // a case variant on a case-insensitive filesystem or a pre-existing hard
  // link; the same device and inode identifies it. lstat, not stat: a symlink
  // pointing at the source is a distinct entry, and following it here would
  // let the rename delete the source and leave the symlink dangling. Stat
  // failures count as a genuine conflict, the safe reading.
  const isSameFile = Effect.fn(function* (leftPath: string, rightPath: string) {
    const stats = yield* Effect.tryPromise(() =>
      Promise.all([
        NodeFSP.lstat(leftPath, { bigint: true }),
        NodeFSP.lstat(rightPath, { bigint: true }),
      ]),
    ).pipe(Effect.orElseSucceed(() => null));
    if (stats === null) {
      return false;
    }
    const [left, right] = stats;
    return left.dev === right.dev && left.ino === right.ino;
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const renameError = (stage: ProjectRenameEntryStage, cause?: unknown) =>
      new ProjectRenameEntryError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        stage,
        cause,
      });

    const [source, target] = yield* Effect.all([
      workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      }),
      workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.newRelativePath,
      }),
    ]).pipe(Effect.mapError((cause) => renameError("resolve-path", cause)));
    if (path.dirname(source.relativePath) !== path.dirname(target.relativePath)) {
      return yield* renameError("cross-directory");
    }

    const sourceStat = yield* fileSystem
      .stat(source.absolutePath)
      .pipe(Effect.mapError((cause) => renameError("resolve-path", cause)));
    if (sourceStat.type !== "File") {
      return yield* renameError("not-a-file");
    }

    const escapes = yield* directoryEscapesWorkspaceRoot(
      input.cwd,
      path.dirname(source.absolutePath),
    ).pipe(Effect.mapError((cause) => renameError("resolve-path", cause)));
    if (escapes) {
      return yield* renameError(
        "resolve-path",
        `'${source.relativePath}' resolves outside the project.`,
      );
    }

    // Renaming a file onto its own exact path is a no-op. Without this guard
    // the identical path would read as a hard link pair below and the source
    // removal would delete the file's only directory entry.
    if (source.relativePath === target.relativePath) {
      return { relativePath: target.relativePath };
    }

    // rename would replace an existing target; link fails atomically instead,
    // so a rename can never clobber another entry. The link and the source
    // removal form one critical section: an interrupt between them would
    // strand both names on disk, so the pair runs uninterruptibly.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const conflict = yield* fileSystem.link(source.absolutePath, target.absolutePath).pipe(
          Effect.as(false),
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.succeed(true),
          ),
          Effect.mapError((cause) => renameError("rename", cause)),
        );
        if (conflict) {
          const sameFile = yield* isSameFile(source.absolutePath, target.absolutePath);
          if (!sameFile) {
            return yield* new ProjectRenameEntryTargetExistsError({
              cwd: input.cwd,
              relativePath: target.relativePath,
            });
          }
          // The conflicting target is another name of the source's own inode.
          // The directory listing reports exact on-disk names and tells the
          // two shapes apart. Both names listed is a pre-existing hard link
          // pair, where POSIX rename over another name of the same file is a
          // no-op, so removing the source entry completes the rename. Only
          // the source listed is the source under another casing on a
          // case-insensitive filesystem, where rename applies the case
          // change. Otherwise the source entry is gone or already carries
          // the target casing, and the target name holds the data.
          const siblingNames = yield* fileSystem
            .readDirectory(path.dirname(source.absolutePath))
            .pipe(Effect.mapError((cause) => renameError("rename", cause)));
          const sourceListed = siblingNames.includes(path.basename(source.absolutePath));
          const targetListed = siblingNames.includes(path.basename(target.absolutePath));
          if (sourceListed && targetListed) {
            return yield* fileSystem.remove(source.absolutePath).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.void,
              ),
              Effect.mapError((cause) => renameError("rename", cause)),
            );
          }
          if (sourceListed) {
            return yield* fileSystem
              .rename(source.absolutePath, target.absolutePath)
              .pipe(Effect.mapError((cause) => renameError("rename", cause)));
          }
          return;
        }
        yield* fileSystem.remove(source.absolutePath).pipe(
          // A missing source means something else removed it after the link
          // landed, leaving the target as the only copy of the data; rolling
          // the link back would destroy it. Only real removal failures, where
          // the source still exists, undo the link.
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.void,
          ),
          Effect.catchTags({
            PlatformError: (cause) =>
              Effect.gen(function* () {
                yield* fileSystem.remove(target.absolutePath, { force: true }).pipe(Effect.ignore);
                return yield* renameError("rename", cause);
              }),
          }),
        );
      }),
    );

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const deleteError = (stage: ProjectDeleteEntryStage, cause?: unknown) =>
      new ProjectDeleteEntryError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        stage,
        cause,
      });

    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      })
      .pipe(Effect.mapError((cause) => deleteError("resolve-path", cause)));

    // A parent directory that fails to canonicalize as missing means the entry
    // is already gone, which counts as a successful delete.
    const escapes = yield* directoryEscapesWorkspaceRoot(
      input.cwd,
      path.dirname(target.absolutePath),
    ).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError((cause) => deleteError("resolve-path", cause)),
    );
    if (escapes === null) {
      return;
    }
    if (escapes) {
      return yield* deleteError(
        "resolve-path",
        `'${target.relativePath}' resolves outside the project.`,
      );
    }

    const targetStat = yield* fileSystem.stat(target.absolutePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError((cause) => deleteError("resolve-path", cause)),
    );
    if (targetStat === null) {
      return;
    }
    if (targetStat.type === "Directory") {
      return yield* deleteError("not-a-file");
    }

    yield* fileSystem
      .remove(target.absolutePath, { force: true })
      .pipe(Effect.mapError((cause) => deleteError("remove", cause)));
    yield* workspaceEntries.refresh(input.cwd);
  });

  return WorkspaceFileSystem.of({ readFile, writeFile, renameEntry, deleteEntry });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
