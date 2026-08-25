import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // An empty query is a bounded browse: the index returns frecency-ordered
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Whitespace is significant in content queries (" foo", regex trailing
  // spaces), so the query is deliberately not trimmed on the wire.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedErrorClass<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const PROJECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const PROJECT_UPLOAD_URL_TTL_MS = 10 * 60_000;

export const ProjectCreateUploadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_UPLOAD_MAX_BYTES)),
  overwrite: Schema.optional(Schema.Boolean),
});
export type ProjectCreateUploadUrlInput = typeof ProjectCreateUploadUrlInput.Type;

export const ProjectCreateUploadUrlResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  // The signed token base64url-encodes the workspace cwd, so the bound must
  // clear a PATH_MAX (4096) cwd plus the longest relative path after the
  // 4/3 encoding overhead.
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  expiresAt: Schema.Number,
});
export type ProjectCreateUploadUrlResult = typeof ProjectCreateUploadUrlResult.Type;

export class ProjectUploadTargetExistsError extends Schema.TaggedErrorClass<ProjectUploadTargetExistsError>()(
  "ProjectUploadTargetExistsError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `A file already exists at '${this.relativePath}' in '${this.cwd}'.`;
  }
}

export const isProjectUploadTargetExistsError = Schema.is(ProjectUploadTargetExistsError);

export const ProjectCreateUploadUrlStage = Schema.Literals([
  "signing-key",
  "resolve-path",
  "target-not-file",
  "target-check",
]);
export type ProjectCreateUploadUrlStage = typeof ProjectCreateUploadUrlStage.Type;

type ProjectCreateUploadUrlFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly stage: ProjectCreateUploadUrlStage;
  readonly cause?: unknown;
};

function projectCreateUploadUrlStageMessage(props: ProjectCreateUploadUrlFailureContext): string {
  switch (props.stage) {
    case "signing-key":
      return "Failed to load the upload signing key.";
    case "resolve-path":
      return `Failed to resolve '${props.relativePath}' within '${props.cwd}'.`;
    case "target-not-file":
      return `'${props.relativePath}' already exists as a folder; uploads can only replace files.`;
    case "target-check":
      return `Failed to check for an existing file at '${props.relativePath}' in '${props.cwd}'.`;
  }
}

export class ProjectCreateUploadUrlError extends Schema.TaggedErrorClass<ProjectCreateUploadUrlError>()(
  "ProjectCreateUploadUrlError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    stage: ProjectCreateUploadUrlStage,
    message: TrimmedNonEmptyString,
    // Validation stages fail without an underlying error, so a cause only
    // accompanies real I/O failures.
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectCreateUploadUrlFailureContext) {
    super({ ...props, message: projectCreateUploadUrlStageMessage(props) } as any);
  }
}

export const ProjectRenameEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  newRelativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
  ),
});
export type ProjectRenameEntryInput = typeof ProjectRenameEntryInput.Type;

export const ProjectRenameEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectRenameEntryResult = typeof ProjectRenameEntryResult.Type;

export class ProjectRenameEntryTargetExistsError extends Schema.TaggedErrorClass<ProjectRenameEntryTargetExistsError>()(
  "ProjectRenameEntryTargetExistsError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `A file already exists at '${this.relativePath}' in '${this.cwd}'.`;
  }
}

export const ProjectRenameEntryStage = Schema.Literals([
  "resolve-path",
  "not-a-file",
  "cross-directory",
  "rename",
]);
export type ProjectRenameEntryStage = typeof ProjectRenameEntryStage.Type;

type ProjectRenameEntryFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly stage: ProjectRenameEntryStage;
  readonly cause: unknown;
};

function projectRenameEntryStageMessage(props: ProjectRenameEntryFailureContext): string {
  switch (props.stage) {
    case "resolve-path":
      return `Failed to resolve '${props.relativePath}' within '${props.cwd}'.`;
    case "not-a-file":
      return `'${props.relativePath}' is not a file.`;
    case "cross-directory":
      return `Cannot rename '${props.relativePath}' into a different directory.`;
    case "rename":
      return `Failed to rename '${props.relativePath}' in '${props.cwd}'.`;
  }
}

export class ProjectRenameEntryError extends Schema.TaggedErrorClass<ProjectRenameEntryError>()(
  "ProjectRenameEntryError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    stage: ProjectRenameEntryStage,
    message: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectRenameEntryFailureContext) {
    super({ ...props, message: projectRenameEntryStageMessage(props) } as any);
  }
}

export const ProjectDeleteEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryStage = Schema.Literals(["resolve-path", "not-a-file", "remove"]);
export type ProjectDeleteEntryStage = typeof ProjectDeleteEntryStage.Type;

type ProjectDeleteEntryFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly stage: ProjectDeleteEntryStage;
  readonly cause: unknown;
};

function projectDeleteEntryStageMessage(props: ProjectDeleteEntryFailureContext): string {
  switch (props.stage) {
    case "resolve-path":
      return `Failed to resolve '${props.relativePath}' within '${props.cwd}'.`;
    case "not-a-file":
      return `'${props.relativePath}' is not a file.`;
    case "remove":
      return `Failed to delete '${props.relativePath}' in '${props.cwd}'.`;
  }
}

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    stage: ProjectDeleteEntryStage,
    message: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectDeleteEntryFailureContext) {
    super({ ...props, message: projectDeleteEntryStageMessage(props) } as any);
  }
}
