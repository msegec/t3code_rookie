import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  looksLikeRepositoryPath,
  repositoryResultItemValue,
  repositoryStepEmptyState,
  repositoryStepEnterAction,
} from "./CommandPalette";

const environmentId = EnvironmentId.make("environment-a");

describe("repositoryStepEnterAction", () => {
  const pathQuery = { queryIsRepositoryPath: true, searchCanAnswer: true } as const;

  it("selects the highlighted repository instead of looking up the raw text", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: repositoryResultItemValue(environmentId, "t3dotgg/t3code"),
        hasPrimaryModifier: false,
        ...pathQuery,
      }),
    ).toBe("select-highlighted-repository");
  });

  it("looks up the typed path when no repository row is highlighted", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: null,
        hasPrimaryModifier: false,
        ...pathQuery,
      }),
    ).toBe("lookup-typed-repository");
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: "browse:/home/user/projects",
        hasPrimaryModifier: false,
        ...pathQuery,
      }),
    ).toBe("lookup-typed-repository");
  });

  it("keeps the exact-path lookup reachable with the primary modifier", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: repositoryResultItemValue(environmentId, "t3dotgg/t3code"),
        hasPrimaryModifier: true,
        ...pathQuery,
      }),
    ).toBe("lookup-typed-repository");
  });

  it("leaves a bare search term with the search instead of erroring through the lookup", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: null,
        hasPrimaryModifier: false,
        queryIsRepositoryPath: false,
        searchCanAnswer: true,
      }),
    ).toBe("continue-search");
  });

  it("looks up a bare term when the search cannot answer", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: null,
        hasPrimaryModifier: false,
        queryIsRepositoryPath: false,
        searchCanAnswer: false,
      }),
    ).toBe("lookup-typed-repository");
  });

  it("forces the lookup of a bare term with the primary modifier", () => {
    expect(
      repositoryStepEnterAction({
        highlightedItemValue: null,
        hasPrimaryModifier: true,
        queryIsRepositoryPath: false,
        searchCanAnswer: true,
      }),
    ).toBe("lookup-typed-repository");
  });
});

describe("looksLikeRepositoryPath", () => {
  it("treats any slash as a repository path, covering nested groups and clone URLs", () => {
    expect(looksLikeRepositoryPath("t3dotgg/t3code")).toBe(true);
    expect(looksLikeRepositoryPath("group/subgroup/project")).toBe(true);
    expect(looksLikeRepositoryPath("https://github.com/t3dotgg/t3code.git")).toBe(true);
  });

  it("treats a bare word as a search term", () => {
    expect(looksLikeRepositoryPath("t3code")).toBe(false);
  });
});

describe("repositoryResultItemValue", () => {
  it("keys a row by environment and repository so identical names across environments stay distinct", () => {
    expect(repositoryResultItemValue(environmentId, "t3dotgg/t3code")).toBe(
      "repo:environment-a:t3dotgg/t3code",
    );
    expect(
      repositoryResultItemValue(EnvironmentId.make("environment-b"), "t3dotgg/t3code"),
    ).not.toBe(repositoryResultItemValue(environmentId, "t3dotgg/t3code"));
  });
});

describe("repositoryStepEmptyState", () => {
  const settled = { supported: true, error: null, isPending: false, canSearch: true } as const;

  it("points a no-match query at the full path, since a bare term no longer submits", () => {
    expect(repositoryStepEmptyState({ source: "github", search: settled })).toBe(
      "No repositories match. Enter owner/repo and press Enter to look it up.",
    );
  });

  it("points at the exact-path input when the provider cannot search", () => {
    expect(
      repositoryStepEmptyState({ source: "gitlab", search: { ...settled, supported: false } }),
    ).toBe("Search is unavailable for GitLab. Enter group/project and press Enter.");
  });

  it("reports the search failing the same way, since the way out is the same", () => {
    expect(
      repositoryStepEmptyState({ source: "github", search: { ...settled, error: "gh exited 1" } }),
    ).toBe("Search is unavailable for GitHub. Enter owner/repo and press Enter.");
  });

  it("expresses loading as a string, because the palette has no spinner", () => {
    expect(
      repositoryStepEmptyState({ source: "github", search: { ...settled, isPending: true } }),
    ).toBe("Searching repositories…");
  });

  it("prompts for a path before the query is long enough to search", () => {
    expect(
      repositoryStepEmptyState({ source: "github", search: { ...settled, canSearch: false } }),
    ).toBe("Enter a repository path and press Enter to look it up.");
  });

  it("leaves the Git URL source alone", () => {
    expect(repositoryStepEmptyState({ source: "url", search: settled })).toBe(
      "Enter a Git clone URL and press Enter to continue.",
    );
  });
});
