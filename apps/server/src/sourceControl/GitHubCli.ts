import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
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
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

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

export class GitHubRepositoryNotFoundError extends Schema.TaggedErrorClass<GitHubRepositoryNotFoundError>()(
  "GitHubRepositoryNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Repository not found. Check the owner/repo path and try again.";
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
  GitHubRepositoryNotFoundError,
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
    if (error.failureKind === "repository-not-found") {
      return new GitHubRepositoryNotFoundError({ ...context, cause: error });
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
     *
     * Built for a search-as-you-type field: the owned listing is cached per
     * working directory, the global search runs only when it can earn its
     * request, and both go through the GitHub circuit breaker. A paused circuit
     * yields whatever is cached, or nothing, rather than an error.
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
 * The viewer's own repositories change on the scale of days and are matched
 * locally, so one listing covers a whole typing session.
 */
const OWNED_REPOSITORIES_TTL_MS = 60_000;

/**
 * Search rows are cached per sanitized query: long enough to absorb backspacing
 * and retyping, short enough that a repository created mid-session turns up.
 */
const SEARCHED_REPOSITORIES_TTL_MS = 30_000;

/**
 * GitHub allows 30 search requests a minute, far tighter than the 5000 an hour
 * the core API allows, so a query has to say something before it costs one.
 */
const MIN_GLOBAL_SEARCH_QUERY_LENGTH = 3;

/**
 * Local matches from this count up already fill the visible part of the
 * dropdown, so a global search would only add rows below the fold.
 */
const SUFFICIENT_LOCAL_MATCHES = 5;

/** A fast typist produces one cache entry per keystroke; bound both caches. */
const SEARCH_CACHE_CAPACITY = 64;

/** Joins cwd and query into one cache key. NUL cannot appear in either part. */
const SEARCH_KEY_SEPARATOR = String.fromCharCode(0);

/** `gh` talks to github.com, and the circuit is keyed by provider and host. */
const GITHUB_RATE_LIMIT_KEY = { provider: "github", host: "github.com" } as const;

interface SearchCacheEntry<A> {
  readonly fetchedAt: number;
  readonly value: A;
}

/** Bounded insert-ordered map. The oldest fetch is evicted first. */
function storeCacheEntry<A>(
  current: ReadonlyMap<string, SearchCacheEntry<A>>,
  key: string,
  entry: SearchCacheEntry<A>,
): ReadonlyMap<string, SearchCacheEntry<A>> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, entry);
  for (const oldest of next.keys()) {
    if (next.size <= SEARCH_CACHE_CAPACITY) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * The search query is free user text, and the only client-supplied value in
 * this file that reaches `gh` argv. Keep it to characters that can appear in an
 * owner or repository name, drop leading dashes so it can never be read as a
 * flag, and cap the length. Applied inside the service so callers cannot skip
 * it. Exported so result ranking can normalize with the same rule the search
 * actually ran under.
 */
export function sanitizeSearchQuery(query: string): string {
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
type RawOwnedRepository = Schema.Schema.Type<typeof RawGitHubOwnedRepositoriesSchema>[number];

/**
 * `gh search repos` uses a different vocabulary from `gh repo list`: the name
 * is `fullName`, stars are `stargazersCount`, and there is no ssh URL, so we
 * derive one. `isFork` means the same thing in both.
 */
const RawGitHubSearchedRepositoriesSchema = Schema.Array(
  Schema.Struct({
    fullName: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
    stargazersCount: Schema.optional(NonNegativeInt),
    isFork: Schema.optional(Schema.Boolean),
    isPrivate: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeRawGitHubSearchedRepositories = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubSearchedRepositoriesSchema),
);
type RawSearchedRepository = Schema.Schema.Type<typeof RawGitHubSearchedRepositoriesSchema>[number];

function deriveSshUrl(nameWithOwner: string, url: string): string {
  try {
    return `git@${new URL(url).host}:${nameWithOwner}.git`;
  } catch {
    return `git@github.com:${nameWithOwner}.git`;
  }
}

/** gh reports a missing description as `null` or `""`; both mean absent. */
function optionalDescription(value: string | null | undefined) {
  return value !== undefined && value !== null && value !== "" ? { description: value } : {};
}

/** The owner segment of `owner/name`, lowercased the way GitHub compares logins. */
function repositoryOwner(nameWithOwner: string): string {
  const separator = nameWithOwner.indexOf("/");
  return (separator === -1 ? nameWithOwner : nameWithOwner.slice(0, separator)).toLowerCase();
}

function normalizeOwnedRepository(raw: RawOwnedRepository): SourceControlRepositorySearchResult {
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
  raw: RawSearchedRepository,
  viewerLogin: string | undefined,
): SourceControlRepositorySearchResult {
  return {
    nameWithOwner: raw.fullName,
    url: raw.url,
    sshUrl: deriveSshUrl(raw.fullName, raw.url),
    ownedByViewer: viewerLogin !== undefined && repositoryOwner(raw.fullName) === viewerLogin,
    ...optionalDescription(raw.description),
    ...(raw.stargazersCount !== undefined ? { starCount: raw.stargazersCount } : {}),
    ...(raw.isFork !== undefined ? { isFork: raw.isFork } : {}),
    ...(raw.isPrivate !== undefined ? { isPrivate: raw.isPrivate } : {}),
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

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

  const ownedRepositoriesCache = yield* Ref.make<
    ReadonlyMap<string, SearchCacheEntry<ReadonlyArray<RawOwnedRepository>>>
  >(new Map());
  const searchedRepositoriesCache = yield* Ref.make<
    ReadonlyMap<string, SearchCacheEntry<ReadonlyArray<RawSearchedRepository>>>
  >(new Map());

  /**
   * One gh request under the GitHub circuit breaker. `null` means the circuit is
   * open and nothing ran, which is the caller's cue to serve whatever it already
   * has. `request` is a thunk so an open circuit builds no command at all.
   */
  const guarded = <A>(request: () => Effect.Effect<A, GitHubCliError>) =>
    limits.check(GITHUB_RATE_LIMIT_KEY).pipe(
      Effect.flatMap((lease) =>
        request().pipe(
          Effect.tap(() => limits.recordSuccess({ ...GITHUB_RATE_LIMIT_KEY, lease })),
          Effect.tapError((error) =>
            error._tag === "GitHubCliRateLimitError"
              ? limits.recordRateLimit({ ...GITHUB_RATE_LIMIT_KEY, lease })
              : Effect.void,
          ),
        ),
      ),
      Effect.catchTags({ SourceControlRateLimitPausedError: () => Effect.succeed(null) }),
    );

  /** Fresh means fetched within the TTL. A clock that stepped backward reads as stale. */
  const isFreshAt = (fetchedAt: number, now: number, ttlMs: number) =>
    now >= fetchedAt && now - fetchedAt < ttlMs;

  /** The viewer's repositories, at most one `gh repo list` per minute per cwd. */
  const fetchOwnedRepositories = (cwd: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(ownedRepositoriesCache)).get(cwd);
      if (cached !== undefined && isFreshAt(cached.fetchedAt, now, OWNED_REPOSITORIES_TTL_MS)) {
        return cached.value;
      }

      const fetched = yield* guarded(() =>
        execute({
          cwd,
          args: [
            "repo",
            "list",
            "--json",
            "nameWithOwner,url,sshUrl,stargazerCount,isFork,isPrivate,description",
            "--limit",
            "100",
          ],
        }).pipe(
          Effect.flatMap((output) =>
            decodeRawGitHubOwnedRepositories(output.stdout.trim()).pipe(
              Effect.mapError(
                (cause) => new GitHubRepositorySearchDecodeError({ command: "gh", cwd, cause }),
              ),
            ),
          ),
        ),
      );
      if (fetched === null) {
        return cached?.value ?? [];
      }

      // Stamp completion, not start: a slow fetch must not age its own entry.
      const fetchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.update(ownedRepositoriesCache, (current) =>
        storeCacheEntry(current, cwd, { fetchedAt, value: fetched }),
      );
      return fetched;
    });

  /** Public repositories for one sanitized query, cached for a few keystrokes. */
  const fetchSearchedRepositories = (key: string) =>
    Effect.gen(function* () {
      const separator = key.indexOf(SEARCH_KEY_SEPARATOR);
      const cwd = key.slice(0, separator);
      const query = key.slice(separator + 1);
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(searchedRepositoriesCache)).get(key);
      if (cached !== undefined && isFreshAt(cached.fetchedAt, now, SEARCHED_REPOSITORIES_TTL_MS)) {
        return cached.value;
      }

      const fetched = yield* guarded(() =>
        execute({
          cwd,
          args: [
            "search",
            "repos",
            query,
            "--json",
            "fullName,url,stargazersCount,isFork,description,isPrivate",
            "--limit",
            "20",
            "--sort",
            "stars",
          ],
        }).pipe(
          Effect.flatMap((output) =>
            decodeRawGitHubSearchedRepositories(output.stdout.trim()).pipe(
              Effect.mapError(
                (cause) => new GitHubRepositorySearchDecodeError({ command: "gh", cwd, cause }),
              ),
            ),
          ),
        ),
      );
      if (fetched === null) {
        return cached?.value ?? [];
      }

      // Stamp completion, not start: a slow fetch must not age its own entry.
      const fetchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.update(searchedRepositoriesCache, (current) =>
        storeCacheEntry(current, key, { fetchedAt, value: fetched }),
      );
      return fetched;
    });

  /**
   * Zero time-to-live makes these caches pure in-flight shares: concurrent
   * callers for one key await the same lookup, and the entry is dropped the
   * moment it settles. Values live in the Ref caches above, which also answer
   * with stale rows while the circuit is paused.
   */
  const ownedRepositoriesInFlight = yield* Cache.makeWith(fetchOwnedRepositories, {
    capacity: SEARCH_CACHE_CAPACITY,
    timeToLive: () => Duration.zero,
  });
  const ownedRepositories = (cwd: string) => Cache.get(ownedRepositoriesInFlight, cwd);

  const searchedRepositoriesInFlight = yield* Cache.makeWith(fetchSearchedRepositories, {
    capacity: SEARCH_CACHE_CAPACITY,
    timeToLive: () => Duration.zero,
  });
  const searchedRepositories = (cwd: string, query: string) =>
    Cache.get(searchedRepositoriesInFlight, cwd + SEARCH_KEY_SEPARATOR + query);

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

        // `gh repo list` takes no query, so the viewer's repositories are matched
        // here against the cached listing. That is the common keystroke: no spawn.
        const owned = yield* ownedRepositories(input.cwd);
        const needle = query.toLowerCase();
        const localMatches = owned.filter((raw) =>
          raw.nameWithOwner.toLowerCase().includes(needle),
        );

        // `gh repo list` lists repositories under the viewer's own login, so any
        // row names the viewer. The listing is capped at 100 rows, which makes
        // membership in it under-report ownership; comparing owner segments does
        // not, so a searched repository the capped listing missed still lands
        // under the viewer's own group.
        const viewerLogin =
          owned[0] !== undefined ? repositoryOwner(owned[0].nameWithOwner) : undefined;

        // A failed global search degrades to the stale cached rows for this
        // query, the same answer the paused circuit already gives, and to the
        // local rows alone when nothing is cached.
        const searched =
          query.length >= MIN_GLOBAL_SEARCH_QUERY_LENGTH &&
          localMatches.length < SUFFICIENT_LOCAL_MATCHES
            ? yield* searchedRepositories(input.cwd, query).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("GitHub repository search failed; serving cached matches", {
                    error,
                  }).pipe(
                    Effect.flatMap(() => Ref.get(searchedRepositoriesCache)),
                    Effect.map(
                      (cache) =>
                        cache.get(input.cwd + SEARCH_KEY_SEPARATOR + query)?.value ??
                        ([] as ReadonlyArray<RawSearchedRepository>),
                    ),
                  ),
                ),
              )
            : [];

        // Owned repositories come first, and one the viewer owns is never
        // repeated by the public search below it. GitHub compares repository
        // names case-insensitively, and the two commands can disagree on
        // casing, so the dedup key is lowercased.
        const results = localMatches.map(normalizeOwnedRepository);
        const seen = new Set(results.map((result) => result.nameWithOwner.toLowerCase()));

        for (const raw of searched) {
          const dedupKey = raw.fullName.toLowerCase();
          if (seen.has(dedupKey)) {
            continue;
          }
          seen.add(dedupKey);
          results.push(normalizeSearchedRepository(raw, viewerLogin));
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

/**
 * The circuit breaker is private to this layer. GitHub bills the search endpoint
 * (30 requests a minute) separately from the core quota the pull-request
 * subsystem tracks with its own `SourceControlRateLimit`, so the two circuits are
 * deliberately independent rather than one pausing the other. `Layer.fresh` is
 * what makes that true: the pull-request subsystem provides the same module-level
 * `SourceControlRateLimit.layer`, and without it Effect would memoize both into
 * one shared instance keyed identically by provider and host.
 */
export const layer = Layer.effect(GitHubCli, make).pipe(
  Layer.provide(Layer.fresh(SourceControlRateLimit.layer)),
);
