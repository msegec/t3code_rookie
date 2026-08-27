// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

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
import * as PlatformError from "effect/PlatformError";

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
    // Both names are genuine directory entries, so the target counts as
    // occupied; only a true case change lists a single name.
    it.effect("rejects renaming onto a hard link of the same file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem
          .link(path.join(cwd, "src/notes.md"), path.join(cwd, "src/Notes.md"))
          .pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/notes.md",
            newRelativePath: "src/Notes.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryTargetExistsError);
        expect(error).toMatchObject({ cwd, relativePath: "src/Notes.md" });
        const sourceExists = yield* fileSystem.exists(path.join(cwd, "src/notes.md"));
        expect(sourceExists).toBe(true);
        const targetContents = yield* fileSystem
          .readFileString(path.join(cwd, "src/Notes.md"))
          .pipe(Effect.orDie);
        expect(targetContents).toBe("# Notes\n");
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

    // The rename moves the link entry itself, matching how deleteEntry drops
    // only the link; the referent must keep its name and contents.
    it.effect("renames a symlink as the link itself without touching its target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem.symlink(path.join(cwd, "src/notes.md"), path.join(cwd, "src/alias.md"));

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/alias.md",
          newRelativePath: "src/renamed.md",
        });

        expect(result).toEqual({ relativePath: "src/renamed.md" });
        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names.toSorted()).toEqual(["notes.md", "renamed.md"]);
        const renamed = path.join(cwd, "src/renamed.md");
        expect(NodeFS.lstatSync(renamed).isSymbolicLink()).toBe(true);
        expect(NodeFS.readlinkSync(renamed)).toBe(path.join(cwd, "src/notes.md"));
        const contents = yield* fileSystem
          .readFileString(path.join(cwd, "src/notes.md"))
          .pipe(Effect.orDie);
        expect(contents).toBe("# Notes\n");
      }),
    );

    // lstat finds the entry a dangling symlink's missing referent would hide
    // from stat, the same way deleteEntry still removes one.
    it.effect("renames a dangling symlink instead of failing on its missing referent", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));
        yield* fileSystem.symlink(
          path.join(cwd, "src/missing.md"),
          path.join(cwd, "src/broken.md"),
        );

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/broken.md",
          newRelativePath: "src/still-broken.md",
        });

        expect(result).toEqual({ relativePath: "src/still-broken.md" });
        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names).toEqual(["still-broken.md"]);
        expect(NodeFS.lstatSync(path.join(cwd, "src/still-broken.md")).isSymbolicLink()).toBe(true);
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
        expect(error).toMatchObject({ stage: "escapes-root" });
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

    // stat follows the link and reads NotFound, so without lstat the delete
    // would report success while the entry stays on disk.
    it.effect("removes a dangling symlink instead of reporting it already gone", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));
        yield* fileSystem.symlink(
          path.join(cwd, "src/missing.md"),
          path.join(cwd, "src/broken.md"),
        );

        yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "src/broken.md" });

        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names).not.toContain("broken.md");
      }),
    );

    it.effect("deletes a symlink without touching its target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem.symlink(path.join(cwd, "src/notes.md"), path.join(cwd, "src/alias.md"));

        yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "src/alias.md" });

        const aliasExists = yield* fileSystem.exists(path.join(cwd, "src/alias.md"));
        expect(aliasExists).toBe(false);
        const contents = yield* fileSystem
          .readFileString(path.join(cwd, "src/notes.md"))
          .pipe(Effect.orDie);
        expect(contents).toBe("# Notes\n");
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

const LinklessTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(linklessFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(LinklessTestLayer, { excludeTestServices: true })(
  "WorkspaceFileSystemLive without hard links",
  (it) => {
    it.effect("renames a file when the volume rejects hard links", () =>
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
        expect(linkRejections.length).toBeGreaterThan(0);
        const renamed = yield* fileSystem
          .readFileString(path.join(cwd, "src/journal.md"))
          .pipe(Effect.orDie);
        expect(renamed).toBe("# Notes\n");
        const sourceExists = yield* fileSystem.exists(path.join(cwd, "src/notes.md"));
        expect(sourceExists).toBe(false);
      }),
    );

    it.effect("still rejects renaming onto an existing entry without hard links", () =>
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

    // exists() follows the link and reads false for a dangling one; the
    // O_EXCL claim fails on the entry itself, so the symlink survives.
    it.effect("rejects renaming onto a dangling symlink without hard links", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        yield* fileSystem.symlink(
          path.join(cwd, "src/missing.md"),
          path.join(cwd, "src/broken.md"),
        );

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/broken.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryTargetExistsError);
        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names).toContain("broken.md");
        expect(names).toContain("source.md");
      }),
    );
  },
);

// Simulates a linkless volume whose rename also fails; when rivalBytesOnRename
// holds bytes, the rename first replaces the target with them, standing in for
// a confirmed overwrite landing between the claim and the rename. When
// statErrorPath names a path, the next stat of that exact path fails once,
// standing in for a transient volume fault between the claim and the inode
// capture; when rivalBytesOnStatError holds bytes, the failing stat first
// replaces the path with them, standing in for a confirmed overwrite landing
// in that same window.
const rivalBytesOnRename: { current: Uint8Array | null } = { current: null };
const statErrorPath: { current: string | null } = { current: null };
const rivalBytesOnStatError: { current: Uint8Array | null } = { current: null };
const brokenRenameFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      stat: (statPath) =>
        Effect.suspend(() => {
          if (statPath !== statErrorPath.current) {
            return real.stat(statPath);
          }
          statErrorPath.current = null;
          const rival = rivalBytesOnStatError.current;
          if (rival) {
            NodeFS.rmSync(statPath, { force: true });
            NodeFS.writeFileSync(statPath, rival);
          }
          return Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "stat",
              syscall: "stat",
              pathOrDescriptor: statPath,
              description: "EIO: the volume failed the stat",
            }),
          );
        }),
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
      rename: (_oldPath, newPath) =>
        Effect.sync(() => {
          const rival = rivalBytesOnRename.current;
          if (rival !== null) {
            const rivalPath = `${newPath}.rival`;
            NodeFS.writeFileSync(rivalPath, rival, { flag: "wx" });
            NodeFS.renameSync(rivalPath, newPath);
          }
        }).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                syscall: "rename",
                pathOrDescriptor: newPath,
                description: "EACCES: the volume failed the rename",
              }),
            ),
          ),
        ),
    });
  }),
);

const BrokenRenameTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(brokenRenameFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(BrokenRenameTestLayer, { excludeTestServices: true })(
  "WorkspaceFileSystemLive when the fallback rename fails",
  (it) => {
    it.effect("reclaims the target name so a retry does not read it as taken", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/renamed.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "rename" });
        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names).toContain("source.md");
        expect(names).not.toContain("renamed.md");
      }),
    );

    // A zero-byte rival is indistinguishable from the claim by size, so this
    // pins the reclaim's inode comparison.
    it.effect("keeps a rival's zero-byte overwrite when the fallback rename fails", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        rivalBytesOnRename.current = new Uint8Array(0);

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/renamed.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "rename" });
        // The rival replaced the claim before the failed rename; the reclaim
        // must not delete it.
        const target = path.join(cwd, "src/renamed.md");
        expect(NodeFS.existsSync(target)).toBe(true);
        expect(NodeFS.readFileSync(target).byteLength).toBe(0);
        expect(NodeFS.existsSync(path.join(cwd, "src/source.md"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rivalBytesOnRename.current = null;
          }),
        ),
      ),
    );

    // A failed claim-inode stat surfaces before any rename runs; without the
    // reclaim the empty claim would make every retry read the name as taken.
    it.effect("reclaims the target name when the claim-inode stat fails", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        statErrorPath.current = path.join(cwd, "src/renamed.md");

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/renamed.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "rename" });
        expect(NodeFS.existsSync(path.join(cwd, "src/renamed.md"))).toBe(false);
        expect(NodeFS.existsSync(path.join(cwd, "src/source.md"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            statErrorPath.current = null;
          }),
        ),
      ),
    );

    // A confirmed overwrite can replace the claim in the same window the stat
    // fault covers; the reclaim must not delete the rival's stored file.
    it.effect("keeps a rival's overwrite when the claim-inode stat fails", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        statErrorPath.current = path.join(cwd, "src/renamed.md");
        rivalBytesOnStatError.current = new TextEncoder().encode("rival\n");

        const error = yield* workspaceFileSystem
          .renameEntry({
            cwd,
            relativePath: "src/source.md",
            newRelativePath: "src/renamed.md",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProjectRenameEntryError);
        expect(error).toMatchObject({ stage: "rename" });
        expect(NodeFS.readFileSync(path.join(cwd, "src/renamed.md"), "utf8")).toBe("rival\n");
        expect(NodeFS.existsSync(path.join(cwd, "src/source.md"))).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            statErrorPath.current = null;
            rivalBytesOnStatError.current = null;
          }),
        ),
      ),
    );
  },
);

// The link lands, then a concurrent writer replaces the source name with a
// new file before the source removal runs.
const linkRivalBytes: { current: Uint8Array | null } = { current: null };
const linkRivalFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      link: (fromPath, toPath) =>
        real.link(fromPath, toPath).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const rival = linkRivalBytes.current;
              if (rival) {
                // A real writer renames its own staged file onto the source
                // name, replacing the inode; remove-then-write reproduces it.
                NodeFS.rmSync(fromPath, { force: true });
                NodeFS.writeFileSync(fromPath, rival);
              }
            }),
          ),
        ),
    });
  }),
);

const LinkRivalTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(linkRivalFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);

// On macOS link(2) follows a symlink source and hard-links its referent,
// unlike Linux where it links the symlink entry itself. Resolving the source
// before linking reproduces the macOS semantics deterministically on Linux.
const derefLinkFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      link: (fromPath, toPath) =>
        real.realPath(fromPath).pipe(Effect.flatMap((resolved) => real.link(resolved, toPath))),
    });
  }),
);

const DerefLinkTestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(derefLinkFileSystemLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(DerefLinkTestLayer, { excludeTestServices: true })(
  "WorkspaceFileSystemLive when link follows symlinks like macOS",
  (it) => {
    // Before symlink sources bypassed the hard-link claim, this flow linked
    // the referent under the new name, saw different inodes, and returned
    // success with the symlink still on disk: a silent duplicate.
    it.effect("renames a symlink instead of hard-linking its referent", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/notes.md", "# Notes\n");
        yield* fileSystem.symlink(path.join(cwd, "src/notes.md"), path.join(cwd, "src/alias.md"));

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/alias.md",
          newRelativePath: "src/renamed.md",
        });

        expect(result).toEqual({ relativePath: "src/renamed.md" });
        const names = yield* fileSystem.readDirectory(path.join(cwd, "src"));
        expect(names.toSorted()).toEqual(["notes.md", "renamed.md"]);
        expect(NodeFS.lstatSync(path.join(cwd, "src/renamed.md")).isSymbolicLink()).toBe(true);
      }),
    );
  },
);

it.layer(LinkRivalTestLayer, { excludeTestServices: true })(
  "WorkspaceFileSystemLive when a writer replaces the source after the link",
  (it) => {
    it.effect("keeps the writer's file instead of removing the source name", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/source.md", "source\n");
        linkRivalBytes.current = new TextEncoder().encode("rival\n");

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          relativePath: "src/source.md",
          newRelativePath: "src/renamed.md",
        });

        expect(result).toEqual({ relativePath: "src/renamed.md" });
        // The rename lands under the new name and the writer's file survives
        // under the old one, the shape a plain rename race would also leave.
        expect(NodeFS.readFileSync(path.join(cwd, "src/renamed.md"), "utf8")).toBe("source\n");
        expect(NodeFS.readFileSync(path.join(cwd, "src/source.md"), "utf8")).toBe("rival\n");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            linkRivalBytes.current = null;
          }),
        ),
      ),
    );
  },
);
