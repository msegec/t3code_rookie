import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
  type SourceControlRepositorySearchResult,
} from "@t3tools/contracts";

import * as GitHubCli from "./GitHubCli.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import { decodeGitHubPullRequestListJson } from "./gitHubPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: GitHubCli.GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

/** One dropdown's worth of rows. Ranking already puts the useful ones first. */
const MAX_SEARCH_RESULTS = 20;

/**
 * GitHub descriptions run to 350 characters and this payload is rebuilt on every
 * keystroke, so descriptions are trimmed to about one list row before they cross
 * the socket. Clients that want the full text read the repository itself.
 */
const MAX_SEARCH_RESULT_DESCRIPTION_LENGTH = 160;

/** True when the query starts the repository name, or the whole `owner/name`. */
function matchesSearchPrefix(result: SourceControlRepositorySearchResult, query: string): boolean {
  if (query.length === 0) {
    return false;
  }
  const nameWithOwner = result.nameWithOwner.toLowerCase();
  const name = nameWithOwner.slice(nameWithOwner.lastIndexOf("/") + 1);
  return nameWithOwner.startsWith(query) || name.startsWith(query);
}

/** Own repositories first, then prefix matches over substring matches, then most stars. */
function compareSearchResults(query: string) {
  return (
    left: SourceControlRepositorySearchResult,
    right: SourceControlRepositorySearchResult,
  ) => {
    if (left.ownedByViewer !== right.ownedByViewer) {
      return left.ownedByViewer ? -1 : 1;
    }
    const leftPrefix = matchesSearchPrefix(left, query);
    const rightPrefix = matchesSearchPrefix(right, query);
    if (leftPrefix !== rightPrefix) {
      return leftPrefix ? -1 : 1;
    }
    return (right.starCount ?? 0) - (left.starCount ?? 0);
  };
}

function trimSearchResultDescription(
  result: SourceControlRepositorySearchResult,
): SourceControlRepositorySearchResult {
  if (
    result.description === undefined ||
    result.description.length <= MAX_SEARCH_RESULT_DESCRIPTION_LENGTH
  ) {
    return result;
  }
  return {
    ...result,
    description: result.description.slice(0, MAX_SEARCH_RESULT_DESCRIPTION_LENGTH).trimEnd(),
  };
}

function rankSearchResults(
  results: ReadonlyArray<SourceControlRepositorySearchResult>,
  query: string,
): ReadonlyArray<SourceControlRepositorySearchResult> {
  // Rank against the query as it actually searched: "t3 code" matched as "t3code".
  return [...results]
    .sort(compareSearchResults(GitHubCli.sanitizeSearchQuery(query).toLowerCase()))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(trimSearchResultDescription);
}

function parseGitHubAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const authenticatedAccount = findAuthenticatedGitHubAccount(authStatus.accounts);
  const host = authenticatedAccount?.host;

  if (authenticatedAccount) {
    return providerAuth({
      status: "authenticated",
      account: authenticatedAccount.account,
      host,
    });
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return providerAuth({
      status: "unauthenticated",
      host: failedAccount?.host,
      detail:
        failedAccount?.error ??
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
    });
  }

  // gh gained `auth status --json` in 2.81.0. Older versions reject the flag and exit
  // non-zero, which reads exactly like a signed-out CLI. Name the real problem instead.
  if (input.exitCode !== 0 && output.includes("unknown flag: --json")) {
    return providerAuth({
      status: "unknown",
      detail:
        "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    (input) => {
      if (input.state === "open") {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: "github",
                  operation: "listChangeRequests",
                  command: error.command,
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
      }

      const stateArg: ChangeRequestState | "all" = input.state;
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            input.headSelector,
            "--state",
            stateArg,
            "--limit",
            String(input.limit ?? 20),
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const raw = result.stdout.trim();
            if (raw.length === 0) {
              return Effect.succeed([]);
            }
            return Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
              Effect.flatMap((decoded) =>
                Result.isSuccess(decoded)
                  ? Effect.succeed(
                      decoded.success.map((item) => {
                        const { updatedAt, ...summary } = item;
                        return {
                          ...toChangeRequest({
                            ...summary,
                            ...(Option.isSome(updatedAt)
                              ? { updatedAt: DateTime.formatIso(updatedAt.value) }
                              : {}),
                          }),
                          updatedAt,
                        };
                      }),
                    )
                  : Effect.fail(
                      new GitHubCli.GitHubChangeRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    ),
              ),
            );
          }),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    };

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      github.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) =>
      github
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    getRepositoryCloneUrls: (input) =>
      github.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              reason:
                error._tag === "GitHubRepositoryNotFoundError" ? "repository-not-found" : undefined,
              cause: error,
            }),
        ),
      ),
    searchRepositories: (input) =>
      github.searchRepositories({ cwd: input.cwd, query: input.query }).pipe(
        Effect.map((results) => ({
          supported: true,
          results: rankSearchResults(results, input.query),
        })),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "searchRepositories",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.query),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      github.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      github.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      github.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "checkoutChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
