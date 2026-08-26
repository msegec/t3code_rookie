import {
  WS_METHODS,
  type EnvironmentId,
  type SourceControlProviderKind,
  type SourceControlRepositorySearchInput,
  type SourceControlRepositorySearchOutput,
} from "@t3tools/contracts";
import { Atom, type AsyncResult } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    repositorySearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository-search",
      tag: WS_METHODS.sourceControlSearchRepositories,
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}

export interface RepositorySearchAnswer {
  readonly supported: boolean;
  readonly error: string | null;
}

const DEFAULT_REPOSITORY_SEARCH_ANSWER: RepositorySearchAnswer = { supported: true, error: null };

/**
 * Sticky `supported`/`error` for the repository search views. Each settled query subscribes to its
 * own atom, so every keystroke starts a pending atom that knows nothing; without memory the UI
 * flashes the searching state and rediscovers `supported: false` on every character. Search support
 * is static per provider, so the last settled answer for an environment+provider stands in while
 * the next query is pending, and the next settled answer (including a recovery from a transient
 * error) replaces it. Callers own `memory` and scope it to the mounted view.
 */
export function resolveRepositorySearchAnswer(input: {
  readonly memory: Map<string, RepositorySearchAnswer>;
  readonly environmentId: EnvironmentId | null;
  readonly provider: SourceControlProviderKind | null;
  /** False when the query is too short to search; remembered answers do not apply there. */
  readonly canSearch: boolean;
  readonly data: { readonly supported: boolean } | null;
  readonly error: string | null;
}): RepositorySearchAnswer {
  const key =
    input.environmentId !== null && input.provider !== null
      ? `${input.environmentId}:${input.provider}`
      : null;
  const settled =
    input.data !== null || input.error !== null
      ? { supported: input.data?.supported ?? true, error: input.error }
      : null;
  if (settled !== null) {
    if (key !== null) input.memory.set(key, settled);
    return settled;
  }
  if (!input.canSearch || key === null) return DEFAULT_REPOSITORY_SEARCH_ANSWER;
  return input.memory.get(key) ?? DEFAULT_REPOSITORY_SEARCH_ANSWER;
}

type AssertTrue<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type RepositorySearchAtomFamily = ReturnType<
  typeof createSourceControlEnvironmentAtoms<never, never>
>["repositorySearch"];
type RepositorySearchValue =
  ReturnType<RepositorySearchAtomFamily> extends Atom.Atom<
    AsyncResult.AsyncResult<infer A, infer _E>
  >
    ? A
    : never;

/**
 * Compile-time proof that `repositorySearch` carries the repository search contract, so
 * dropping the key or pointing it at another RPC tag fails here instead of in web or mobile.
 */
type _RepositorySearchTakesSearchInput = AssertTrue<
  Exact<Parameters<RepositorySearchAtomFamily>[0]["input"], SourceControlRepositorySearchInput>
>;
type _RepositorySearchYieldsSearchOutput = AssertTrue<
  Exact<RepositorySearchValue, SourceControlRepositorySearchOutput>
>;
