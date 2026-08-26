import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositorySearchResult,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedErrorClass<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedErrorClass<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliRateLimitError extends Schema.TaggedErrorClass<GitHubCliRateLimitError>()(
  "GitHubCliRateLimitError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedErrorClass<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedErrorClass<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export class GitHubRepositorySearchDecodeError extends Schema.TaggedErrorClass<GitHubRepositorySearchDecodeError>()(
  "GitHubRepositorySearchDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository search JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in searchRepositories: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubCliRateLimitError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
  GitHubRepositorySearchDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "rate-limited") {
      return new GitHubCliRateLimitError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      /** Piped to the child's stdin, for payloads that must never appear in argv. */
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    /**
     * Repositories matching a free-text query: the viewer's own repositories
     * that contain the query, then public repositories GitHub search returns.
     * The query is sanitized here, so no caller can widen what reaches argv.
     */
    readonly searchRepositories: (input: {
      readonly cwd: string;
      readonly query: string;
    }) => Effect.Effect<ReadonlyArray<SourceControlRepositorySearchResult>, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

/** Longest query we hand to `gh`. Repository names are far shorter than this. */
const SEARCH_QUERY_MAX_LENGTH = 128;

/**
 * The search query is free user text, and the only client-supplied value in
 * this file that reaches `gh` argv. Keep it to characters that can appear in an
 * owner or repository name, drop leading dashes so it can never be read as a
 * flag, and cap the length. Applied inside the service so callers cannot skip
 * it.
 */
function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .replace(/^-+/, "")
    .slice(0, SEARCH_QUERY_MAX_LENGTH);
}

/** `gh repo list` reports stars as `stargazerCount` and ships an ssh URL. */
const RawGitHubOwnedRepositoriesSchema = Schema.Array(
  Schema.Struct({
    nameWithOwner: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
    sshUrl: TrimmedNonEmptyString,
    stargazerCount: Schema.optional(NonNegativeInt),
    isFork: Schema.optional(Schema.Boolean),
    isPrivate: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeRawGitHubOwnedRepositories = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubOwnedRepositoriesSchema),
);

/**
 * `gh search repos` uses a different vocabulary from `gh repo list`: the name
 * is `fullName`, stars are `stargazersCount`, and there is no ssh URL, so we
 * derive one. `forksCount` is requested for parity with the search UI but
 * counts a repository's forks, which is not the `isFork` flag, so search
 * results carry no fork flag.
 */
const RawGitHubSearchedRepositoriesSchema = Schema.Array(
  Schema.Struct({
    fullName: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
    stargazersCount: Schema.optional(NonNegativeInt),
    isPrivate: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeRawGitHubSearchedRepositories = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubSearchedRepositoriesSchema),
);

function deriveSshUrl(nameWithOwner: string, url: string): string {
  try {
    return `git@${new URL(url).host}:${nameWithOwner}.git`;
  } catch {
    return `git@github.com:${nameWithOwner}.git`;
  }
}

function optionalDescription(value: string | null | undefined) {
  return value !== undefined && value !== null ? { description: value } : {};
}

function normalizeOwnedRepository(
  raw: Schema.Schema.Type<typeof RawGitHubOwnedRepositoriesSchema>[number],
): SourceControlRepositorySearchResult {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
    ownedByViewer: true,
    ...optionalDescription(raw.description),
    ...(raw.stargazerCount !== undefined ? { starCount: raw.stargazerCount } : {}),
    ...(raw.isFork !== undefined ? { isFork: raw.isFork } : {}),
    ...(raw.isPrivate !== undefined ? { isPrivate: raw.isPrivate } : {}),
  };
}

function normalizeSearchedRepository(
  raw: Schema.Schema.Type<typeof RawGitHubSearchedRepositoriesSchema>[number],
): SourceControlRepositorySearchResult {
  return {
    nameWithOwner: raw.fullName,
    url: raw.url,
    sshUrl: deriveSshUrl(raw.fullName, raw.url),
    ownedByViewer: false,
    ...optionalDescription(raw.description),
    ...(raw.stargazersCount !== undefined ? { starCount: raw.stargazersCount } : {}),
    ...(raw.isPrivate !== undefined ? { isPrivate: raw.isPrivate } : {}),
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    searchRepositories: (input) =>
      Effect.gen(function* () {
        const query = sanitizeSearchQuery(input.query);
        if (query.length === 0) {
          return [];
        }

        const ownedOutput = yield* execute({
          cwd: input.cwd,
          args: [
            "repo",
            "list",
            "--json",
            "nameWithOwner,url,sshUrl,stargazerCount,isFork,isPrivate,description",
            "--limit",
            "100",
          ],
        });
        const owned = yield* decodeRawGitHubOwnedRepositories(ownedOutput.stdout.trim()).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubRepositorySearchDecodeError({ command: "gh", cwd: input.cwd, cause }),
          ),
        );

        const searchOutput = yield* execute({
          cwd: input.cwd,
          args: [
            "search",
            "repos",
            query,
            "--json",
            "fullName,url,stargazersCount,forksCount,description,isPrivate",
            "--limit",
            "20",
            "--sort",
            "stars",
          ],
        });
        const searched = yield* decodeRawGitHubSearchedRepositories(
          searchOutput.stdout.trim(),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubRepositorySearchDecodeError({ command: "gh", cwd: input.cwd, cause }),
          ),
        );

        // `gh repo list` takes no query, so the viewer's repositories are
        // matched here. They come first, and a repository the viewer owns is
        // never repeated by the public search below it.
        const needle = query.toLowerCase();
        const results = owned
          .filter((raw) => raw.nameWithOwner.toLowerCase().includes(needle))
          .map(normalizeOwnedRepository);
        const seen = new Set(results.map((result) => result.nameWithOwner));

        for (const raw of searched) {
          if (seen.has(raw.fullName)) {
            continue;
          }
          seen.add(raw.fullName);
          results.push(normalizeSearchedRepository(raw));
        }

        return results;
      }),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make);
