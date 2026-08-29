import { assert, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { SourceControlRepositorySearchResult } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeProvider(github: Partial<GitHubCli.GitHubCli["Service"]>) {
  return GitHubSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(GitHubCli.GitHubCli)(github)),
  );
}

it.effect("maps GitHub PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitHub provider",
          url: "https://github.com/pingdotgg/t3code/pull/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/t3code",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "github",
      number: 42,
      title: "Add GitHub provider",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds safe request context while retaining GitHub CLI causes", () =>
  Effect.gen(function* () {
    const cause = new GitHubCli.GitHubPullRequestNotFoundError({
      command: "gh",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://user:secret@github.com/pingdotgg/t3code/pull/42?token=secret#diff",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "github",
        operation: "getChangeRequest",
        command: "gh",
        cwd: "/repo",
        reference: "https://github.com/pingdotgg/t3code/pull/42",
        detail: "Pull request not found. Check the PR number or URL and try again.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("uses gh json listing for non-open change request state queries", () =>
  Effect.gen(function* () {
    let executeArgs: ReadonlyArray<string> = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        executeArgs = input.args;
        return Effect.succeed(
          processResult(
            JSON.stringify([
              {
                number: 7,
                title: "Merged work",
                url: "https://github.com/pingdotgg/t3code/pull/7",
                baseRefName: "main",
                headRefName: "feature/merged",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ),
        );
      },
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(executeArgs, [
      "pr",
      "list",
      "--head",
      "feature/merged",
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
    ]);
    assert.strictEqual(changeRequests[0]?.provider, "github");
    assert.strictEqual(changeRequests[0]?.state, "merged");
    assert.deepStrictEqual(
      changeRequests[0]?.updatedAt,
      Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    );
  }),
);

it.effect("treats empty non-open change request listing output as no results", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      execute: () => Effect.succeed(processResult("")),
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/empty",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(changeRequests, []);
  }),
);

it.effect("creates GitHub PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GitHubCli.GitHubCli["Service"]["createPullRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

const SEARCH_DESCRIPTION_CAP = 160;

function searchResult(
  overrides: Partial<SourceControlRepositorySearchResult> & { readonly nameWithOwner: string },
): SourceControlRepositorySearchResult {
  return {
    url: `https://github.com/${overrides.nameWithOwner}`,
    sshUrl: `git@github.com:${overrides.nameWithOwner}.git`,
    ownedByViewer: false,
    starCount: 0,
    ...overrides,
  };
}

it.effect("ranks, caps, and trims the repository search results it returns", () =>
  Effect.gen(function* () {
    // Every adjacent pair below is decided by a different rule, so dropping or
    // reordering any one of them changes this expectation.
    const owned = searchResult({
      nameWithOwner: "mark/t3code-tools",
      ownedByViewer: true,
      starCount: 1,
      description: "a".repeat(400),
    });
    const ownedSubstring = searchResult({
      nameWithOwner: "mark/awesome-t3code",
      ownedByViewer: true,
      starCount: 9000,
    });
    const prefixPopular = searchResult({
      nameWithOwner: "pingdotgg/t3code",
      starCount: 5000,
      description: "Short and untouched.",
    });
    const prefixQuiet = searchResult({ nameWithOwner: "forks/t3code-mirror", starCount: 100 });
    const substringPopular = searchResult({ nameWithOwner: "legacy/old-t3code", starCount: 4000 });
    const filler = Array.from({ length: 20 }, (_unused, index) =>
      searchResult({ nameWithOwner: `filler/pack-t3code-${index}` }),
    );

    let searchInput: { readonly cwd: string; readonly query: string } | null = null;
    const provider = yield* makeProvider({
      searchRepositories: (input) => {
        searchInput = input;
        return Effect.succeed([
          ...filler,
          substringPopular,
          prefixPopular,
          ownedSubstring,
          prefixQuiet,
          owned,
        ]);
      },
    });

    const output = yield* provider.searchRepositories({ cwd: "/repo", query: "t3code" });

    assert.deepStrictEqual(searchInput, { cwd: "/repo", query: "t3code" });
    assert.strictEqual(output.supported, true);
    assert.strictEqual(output.results.length, 20);
    assert.deepStrictEqual(
      output.results.slice(0, 5).map((result) => result.nameWithOwner),
      [
        "mark/t3code-tools",
        "mark/awesome-t3code",
        "pingdotgg/t3code",
        "forks/t3code-mirror",
        "legacy/old-t3code",
      ],
    );
    assert.strictEqual(output.results[0]?.description, "a".repeat(SEARCH_DESCRIPTION_CAP));
    assert.strictEqual(output.results[2]?.description, "Short and untouched.");
  }),
);

it.effect("ranks a spaced query the way the search actually ran it", () =>
  Effect.gen(function* () {
    // "t3 code" reaches gh as "t3code" after sanitizing, so ranking must use
    // the sanitized form too: the exact-name match beats the popular substring.
    const exact = searchResult({ nameWithOwner: "pingdotgg/t3code", starCount: 10 });
    const popularSubstring = searchResult({
      nameWithOwner: "acme/uses-t3code-inside",
      starCount: 5000,
    });
    const provider = yield* makeProvider({
      searchRepositories: () => Effect.succeed([popularSubstring, exact]),
    });

    const output = yield* provider.searchRepositories({ cwd: "/repo", query: "t3 code" });

    assert.strictEqual(output.supported, true);
    assert.deepStrictEqual(
      output.results.map((result) => result.nameWithOwner),
      ["pingdotgg/t3code", "acme/uses-t3code-inside"],
    );
  }),
);

it.effect("redacts search queries in provider errors while keeping the CLI cause", () =>
  Effect.gen(function* () {
    const cause = new GitHubCli.GitHubRepositorySearchDecodeError({
      command: "gh",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      searchRepositories: () => Effect.fail(cause),
    });

    const error = yield* provider
      .searchRepositories({
        cwd: "/repo",
        query: "https://user:secret@github.com/pingdotgg/t3code?token=secret",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "github",
        operation: "searchRepositories",
        command: "gh",
        cwd: "/repo",
        repository: "https://github.com/pingdotgg/t3code",
        detail: "GitHub CLI returned invalid repository search JSON.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

// Search-as-you-type would raise one toast per keystroke if a paused circuit failed,
// so the whole path down to the process boundary has to answer with data instead.
it.effect("answers with empty results instead of an error while the GitHub circuit is open", () =>
  Effect.gen(function* () {
    const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const key = { provider: "github" as const, host: "github.com" };
    const lease = yield* limits.check(key);
    yield* limits.recordRateLimit({ ...key, lease });

    const provider = yield* GitHubSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.effect(GitHubCli.GitHubCli, GitHubCli.make).pipe(
          Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run })),
          Layer.provide(Layer.succeed(SourceControlRateLimit.SourceControlRateLimit, limits)),
        ),
      ),
    );

    const output = yield* provider.searchRepositories({ cwd: "/repo", query: "codething" });

    assert.deepStrictEqual(output, { supported: true, results: [] });
    expect(run).not.toHaveBeenCalled();
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it("accepts active authenticated GitHub accounts when another account fails", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth JSON from stdout when stderr has warnings", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
      { stderr: "warning: ignored diagnostic from gh\n" },
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth status accounts by host and active state", () => {
  assert.deepStrictEqual(
    parseGitHubAuthStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "enterprise-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
    ).accounts,
    [
      {
        host: "github.com",
        account: "active-user",
        authenticated: true,
        active: true,
        error: null,
      },
      {
        host: "github.com",
        account: "stale-user",
        authenticated: false,
        active: false,
        error: null,
      },
      {
        host: "github.example.test",
        account: "enterprise-user",
        authenticated: true,
        active: false,
        error: null,
      },
    ],
  );
});

it("reports unauthenticated when GitHub JSON has accounts but none are valid", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              active: true,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      host: auth.host,
      detail: auth.detail,
    },
    {
      status: "unauthenticated",
      host: Option.some("github.com"),
      detail: Option.some("The token in keyring is invalid."),
    },
  );
});

it("reports an update hint instead of unauthenticated when gh predates --json", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult("", {
      stderr: "unknown flag: --json\n\nUsage:  gh auth status [flags]\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    }),
  );

  assert.strictEqual(auth.status, "unknown");
  assert.match(
    Option.getOrElse(auth.detail, () => ""),
    /2\.81\.0/,
  );
});
