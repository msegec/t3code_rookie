import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import {
  ProjectDeleteEntryError,
  ProjectRenameEntryError,
  ProjectRenameEntryTargetExistsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("renameEntry", () => {
    it.effect("renames a file within its directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/notes.md",
          newRelativePath: "src/journal.md",
        });

        expect(result).toEqual({ relativePath: "src/journal.md" });
        const renamed = yield* fileSystem
          .readFileString(path.join(cwd, "src/journal.md"))
          .pipe(Effect.orDie);
        expect(renamed).toBe("# Notes\n");
        const sourceExists = yield* fileSystem.exists(path.join(cwd, "src/notes.md"));
        expect(sourceExists).toBe(false);
      }),
    );

    it.effect("invalidates workspace entry search cache after renames", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# Notes\n");
        const beforeRename = yield* workspaceEntries.list({ cwd });
        expect(beforeRename.entries.some((entry) => entry.path === "journal.md")).toBe(false);

        yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "notes.md",
          newRelativePath: "journal.md",
        });

        const afterRename = yield* workspaceEntries.list({ cwd });
        expect(afterRename.entries.some((entry) => entry.path === "journal.md")).toBe(true);
        expect(afterRename.entries.some((entry) => entry.path === "notes.md")).toBe(false);
      }),
    );

    it.effect("rejects renaming onto an existing entry without overwriting it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        yield* writeTextFile(cwd, "src/taken.md", "taken\n");

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/taken.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryTargetExistsError);
        expect(error).toMatchObject({ cwd, relativePath: "src/taken.md" });
        const source = yield* fileSystem
          .readFileString(path.join(cwd, "src/source.md"))
          .pipe(Effect.orDie);
        expect(source).toBe("source\n");
        const taken = yield* fileSystem
          .readFileString(path.join(cwd, "src/taken.md"))
          .pipe(Effect.orDie);
        expect(taken).toBe("taken\n");
      }),
    );

    it.effect("leaves the file untouched when renamed onto its own path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/notes.md",
          newRelativePath: "src/notes.md",
        });

        expect(result).toEqual({ relativePath: "src/notes.md" });
        const contents = yield* fileSystem
          .readFileString(path.join(cwd, "src/notes.md"))
          .pipe(Effect.orDie);
        expect(contents).toBe("# Notes\n");
      }),
    );

    // A hard-linked target reaches the same-inode path a case-only rename
    // takes on a case-insensitive filesystem, deterministically on Linux.
    it.effect("renames onto another name of the same file without destroying it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem
          .link(path.join(cwd, "src/notes.md"), path.join(cwd, "src/Notes.md"))
          .pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/notes.md",
          newRelativePath: "src/Notes.md",
        });

        expect(result).toEqual({ relativePath: "src/Notes.md" });
        const renamed = yield* fileSystem
          .readFileString(path.join(cwd, "src/Notes.md"))
          .pipe(Effect.orDie);
        expect(renamed).toBe("# Notes\n");
        const sourceExists = yield* fileSystem.exists(path.join(cwd, "src/notes.md"));
        expect(sourceExists).toBe(false);
      }),
    );

    // A symlink at the target stats to the source's inode but is its own
    // entry; treating it as the same file would delete the source and leave
    // the symlink dangling.
    it.effect("rejects renaming onto a symlink that points at the source", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem
          .symlink(path.join(cwd, "src/notes.md"), path.join(cwd, "src/link.md"))
          .pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/notes.md",
            newRelativePath: "src/link.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryTargetExistsError);
        expect(error).toMatchObject({ cwd, relativePath: "src/link.md" });
        const source = yield* fileSystem
          .readFileString(path.join(cwd, "src/notes.md"))
          .pipe(Effect.orDie);
        expect(source).toBe("# Notes\n");
      }),
    );

    it.effect("rejects renames that leave the source directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/notes.md",
            newRelativePath: "docs/notes.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({
          cwd,
          relativePath: "src/notes.md",
          stage: "cross-directory",
        });
      }),
    );

    it.effect("rejects renaming a directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src",
            newRelativePath: "lib",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "not-a-file" });
      }),
    );

    it.effect("rejects renames whose directory resolves outside the root through a symlink", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "owned.txt", "outside\n");
        yield* fileSystem.symlink(outside, path.join(cwd, "linked"));

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "linked/owned.txt",
            newRelativePath: "linked/renamed.txt",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "resolve-path" });
        const untouched = yield* fileSystem
          .readFileString(path.join(outside, "owned.txt"))
          .pipe(Effect.orDie);
        expect(untouched).toBe("outside\n");
        const renamedExists = yield* fileSystem.exists(path.join(outside, "renamed.txt"));
        expect(renamedExists).toBe(false);
      }),
    );
  });

  describe("deleteEntry", () => {
    it.effect("deletes a file relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");

        yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "src/notes.md" });

        const exists = yield* fileSystem.exists(path.join(cwd, "src/notes.md"));
        expect(exists).toBe(false);
      }),
    );

    it.effect("succeeds when the file is already missing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "missing/notes.md" });
      }),
    );

    it.effect("rejects deleting a directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "src" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectDeleteEntryError);
        expect(error).toMatchObject({ stage: "not-a-file" });
        const stillThere = yield* fileSystem.exists(path.join(cwd, "src/index.ts"));
        expect(stillThere).toBe(true);
      }),
    );
  });
});
