import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRepositorySearchTarget,
  buildSearchedRepositoryDestination,
  groupRepositorySearchResults,
  repositorySearchEmptyState,
  resolveAddProjectEnvironment,
} from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });

  it("resolves an explicit connected environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "connected"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      )?.environmentId,
    ).toBe(ENVIRONMENT_A);
  });

  it("defaults to the first connected environment when no environment is requested", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        null,
      )?.environmentId,
    ).toBe(ENVIRONMENT_B);
  });
});

describe("buildRepositorySearchTarget", () => {
  const settled = {
    environmentId: ENVIRONMENT_A,
    provider: "github" as const,
  };

  it("fires no request below the minimum query length", () => {
    expect(buildRepositorySearchTarget({ ...settled, query: "t", debouncedQuery: "t" })).toBeNull();
  });

  it("subscribes once the query is long enough and has settled", () => {
    expect(
      buildRepositorySearchTarget({ ...settled, query: " t3 ", debouncedQuery: "t3" }),
    ).toEqual({
      environmentId: ENVIRONMENT_A,
      input: { provider: "github", query: "t3" },
    });
  });

  it("blanks results while the query is still settling", () => {
    expect(
      buildRepositorySearchTarget({ ...settled, query: "t3co", debouncedQuery: "t3" }),
    ).toBeNull();
  });
});

describe("buildSearchedRepositoryDestination", () => {
  it("navigates with the selected repository instead of looking it up again", () => {
    expect(
      buildSearchedRepositoryDestination({
        environmentId: ENVIRONMENT_A,
        source: "github",
        result: {
          nameWithOwner: "t3dotgg/t3code",
          url: "https://github.com/t3dotgg/t3code",
          sshUrl: "git@github.com:t3dotgg/t3code.git",
          ownedByViewer: true,
        },
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_A,
      source: "github",
      remoteUrl: "https://github.com/t3dotgg/t3code",
      repositoryTitle: "t3dotgg/t3code",
      repositoryName: "t3code",
    });
  });
});

describe("groupRepositorySearchResults", () => {
  function result(nameWithOwner: string, ownedByViewer: boolean) {
    return {
      nameWithOwner,
      url: `https://github.com/${nameWithOwner}`,
      sshUrl: `git@github.com:${nameWithOwner}.git`,
      ownedByViewer,
    };
  }

  it("keeps the server ranking within a group and drops groups with no rows", () => {
    expect(
      groupRepositorySearchResults(
        [result("me/one", true), result("other/two", false), result("me/three", true)],
        "github",
      ),
    ).toEqual([
      {
        key: "owned",
        label: "Your repositories",
        results: [result("me/one", true), result("me/three", true)],
      },
      { key: "other", label: "GitHub", results: [result("other/two", false)] },
    ]);
    expect(groupRepositorySearchResults([result("me/one", true)], "github")).toEqual([
      { key: "owned", label: "Your repositories", results: [result("me/one", true)] },
    ]);
  });
});

describe("repositorySearchEmptyState", () => {
  const settled = { supported: true, error: null, isPending: false, canSearch: true } as const;

  it("shows the ordinary empty state when a supported provider returns nothing", () => {
    expect(repositorySearchEmptyState({ source: "github", ...settled })).toBe(
      "No repositories match. Press Enter to look up the exact path.",
    );
  });

  it("points at the exact-path input when the provider cannot search", () => {
    expect(repositorySearchEmptyState({ source: "github", ...settled, supported: false })).toBe(
      "Search is unavailable for GitHub. Enter owner/repo and press Enter.",
    );
  });

  it("reports a failed search the same way, since the way out is the same", () => {
    expect(repositorySearchEmptyState({ source: "github", ...settled, error: "gh exited 1" })).toBe(
      "Search is unavailable for GitHub. Enter owner/repo and press Enter.",
    );
  });

  it("expresses loading as a string, because the list has no spinner", () => {
    expect(repositorySearchEmptyState({ source: "github", ...settled, isPending: true })).toBe(
      "Searching repositories…",
    );
  });

  it("says nothing before the query is long enough, since the placeholder already prompts", () => {
    expect(
      repositorySearchEmptyState({ source: "github", ...settled, canSearch: false }),
    ).toBeNull();
  });

  it("leaves the Git URL source alone", () => {
    expect(repositorySearchEmptyState({ source: "url", ...settled })).toBeNull();
  });
});
