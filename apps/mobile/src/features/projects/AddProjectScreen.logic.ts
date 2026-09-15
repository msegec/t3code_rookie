import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  canCreateProjectInEnvironment,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  type AddProjectRemoteProviderKind,
  type AddProjectRemoteSource,
} from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  SourceControlRepositorySearchInput,
  SourceControlRepositorySearchResult,
} from "@t3tools/contracts";

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}

export const REPOSITORY_SEARCH_DEBOUNCE_MS = 200;
export const REPOSITORY_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Target for the repository search query, or null to leave it unsubscribed. Null below the minimum
 * length keeps short prefixes off the wire, and null while the typed query still differs from the
 * debounced one blanks the list rather than leaving a previous owner prefix's matches on screen.
 */
export function buildRepositorySearchTarget(input: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: AddProjectRemoteProviderKind | null;
  readonly query: string;
  readonly debouncedQuery: string;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: SourceControlRepositorySearchInput;
} | null {
  const query = input.query.trim();
  if (input.environmentId === null || input.provider === null) return null;
  if (query.length < REPOSITORY_SEARCH_MIN_QUERY_LENGTH) return null;
  if (query !== input.debouncedQuery.trim()) return null;
  return {
    environmentId: input.environmentId,
    input: { provider: input.provider, query },
  };
}

/** A searched row already carries both clone URLs, so selecting one skips the lookup round trip. */
export function buildSearchedRepositoryDestination(input: {
  readonly environmentId: EnvironmentId;
  readonly source: AddProjectRemoteProviderKind;
  readonly result: SourceControlRepositorySearchResult;
}): {
  readonly environmentId: EnvironmentId;
  readonly source: AddProjectRemoteProviderKind;
  readonly remoteUrl: string;
  readonly repositoryTitle: string;
  readonly repositoryName: string;
} {
  return {
    environmentId: input.environmentId,
    source: input.source,
    remoteUrl: getDefaultCloneUrl({
      provider: input.source,
      url: input.result.url,
      sshUrl: input.result.sshUrl,
    }),
    repositoryTitle: input.result.nameWithOwner,
    repositoryName: getCloneDirectoryName(input.result.nameWithOwner),
  };
}

export interface RepositorySearchGroup {
  readonly key: string;
  readonly label: string;
  readonly results: ReadonlyArray<SourceControlRepositorySearchResult>;
}

/**
 * Splits results into the two rendered groups. Ranking, the 20-result cap, and description
 * truncation all happen server-side, so group membership is the only client decision left.
 */
export function groupRepositorySearchResults(
  results: ReadonlyArray<SourceControlRepositorySearchResult>,
  source: AddProjectRemoteProviderKind,
): ReadonlyArray<RepositorySearchGroup> {
  const owned = results.filter((result) => result.ownedByViewer);
  const others = results.filter((result) => !result.ownedByViewer);
  const groups: RepositorySearchGroup[] = [];
  if (owned.length > 0) {
    groups.push({ key: "owned", label: "Your repositories", results: owned });
  }
  if (others.length > 0) {
    groups.push({ key: "other", label: addProjectRemoteSourceLabel(source), results: others });
  }
  return groups;
}

/**
 * The one line rendered under the input when the search has no rows to show. Both empty successes
 * stay here rather than becoming errors: a paused rate-limit circuit answers `supported: true` with
 * no results and gets the ordinary empty state, while a provider that cannot search answers
 * `supported: false` and gets the affordance pointing back at the exact-path input. Loading is a
 * string because this screen has no spinner for the list.
 */
export function repositorySearchEmptyState(input: {
  readonly source: AddProjectRemoteSource;
  readonly supported: boolean;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly canSearch: boolean;
}): string | null {
  if (input.source === "url") return null;
  if (!input.canSearch) return null;
  if (!input.supported || input.error !== null) {
    return `Search is unavailable for ${addProjectRemoteSourceLabel(input.source)}. Enter ${addProjectRemoteSourcePathHint(input.source)} and press Enter.`;
  }
  if (input.isPending) return "Searching repositories…";
  return "No repositories match. Press Enter to look up the exact path.";
}
