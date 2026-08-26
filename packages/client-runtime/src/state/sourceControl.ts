import {
  WS_METHODS,
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
