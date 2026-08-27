import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as TestClock from "effect/testing/TestClock";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

/**
 * Repository search reads the clock and the GitHub circuit, so its tests build the
 * CLI over a rate limiter they can pause rather than over `GitHubCli.layer`, which
 * provides one of its own.
 */
const searchLayer = Layer.effect(GitHubCli.GitHubCli, GitHubCli.make).pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
  Layer.provideMerge(SourceControlRateLimit.layer),
);

/**
 * The real `GitHubCli.layer` built alongside an outer `SourceControlRateLimit`,
 * the way `server.ts` builds it next to the pull-request subsystem's. Both sides
 * reference the same module-level layer, so without `Layer.fresh` inside
 * `GitHubCli.layer` Effect would memoize them into one shared circuit.
 */
const sharedCircuitLayer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
  Layer.provideMerge(SourceControlRateLimit.layer),
);

/** The gh subcommand of every spawn so far, in order. */
const spawnedSubcommands = () =>
  mockRun.mock.calls.map((call) => call[0].args.slice(0, 2).join(" "));

const ownedRepository = (nameWithOwner: string) => ({
  nameWithOwner,
  url: `https://github.com/${nameWithOwner}`,
  sshUrl: `git@github.com:${nameWithOwner}.git`,
});

afterEach(() => {
  mockRun.mockReset();
});

describe("GitHubCli.layer", () => {
  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps pull requests from gh versions without headRepository.nameWithOwner", () =>
    // gh < 2.47 (e.g. Ubuntu-packaged 2.46) exports headRepository as
    // {id, name} only. These entries must decode instead of being dropped,
    // with nameWithOwner rebuilt from the owner login.
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 2829,
                title: "Codex turn mapping",
                url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
                baseRefName: "main",
                headRefName: "t3code/codex-turn-mapping",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: {
                  id: "R_kgDORLtfbQ",
                  name: "codething-mvp",
                },
                headRepositoryOwner: {
                  id: "MDEyOk9yZ2FuaXphdGlvbjg5MTkxNzI3",
                  login: "pingdotgg",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "t3code/codex-turn-mapping",
      });

      assert.deepStrictEqual(result, [
        {
          number: 2829,
          title: "Codex turn mapping",
          url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
          baseRefName: "main",
          headRefName: "t3code/codex-turn-mapping",
          state: "open",
          isCrossRepository: false,
          headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
          headRepositoryOwnerLogin: "pingdotgg",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps a repository resolution failure to GitHubRepositoryNotFoundError", () =>
    Effect.gen(function* () {
      const exitError = VcsProcessExitError.fromProcessExit(
        {
          operation: "GitHubCli.execute",
          command: "gh",
          cwd: "/repo",
          argumentCount: 5,
        },
        {
          exitCode: 1,
          stderr:
            "GraphQL: Could not resolve to a Repository with the name 'octocat/nope'. (repository)",
          stderrTruncated: false,
        },
        "repository-not-found",
      );
      assert.strictEqual(exitError.detail, "Repository not found.");
      mockRun.mockReturnValueOnce(Effect.fail(exitError));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* Effect.flip(
        gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/nope",
        }),
      );

      assert.strictEqual(error._tag, "GitHubRepositoryNotFoundError");
      assert.strictEqual(
        error.detail,
        "Repository not found. Check the owner/repo path and try again.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces an actionable rate-limit error without exposing provider stderr", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "rate-limited",
        detail: "API rate limit exceeded.",
        stderrLength: 82,
        stderrTruncated: false,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/rate-limited",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      assert.include(error.detail, "GitHub API rate limit exceeded");
      assert.include(error.detail, "gh api rate_limit");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "user ID");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("searches owned repositories and public repositories with the documented argv", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                description: "Minimal GUI for coding agents",
                isFork: false,
                isPrivate: false,
                nameWithOwner: "octocat/codething-mvp",
                sshUrl: "git@github.com:octocat/codething-mvp.git",
                stargazerCount: 42,
                url: "https://github.com/octocat/codething-mvp",
              },
              {
                description: "",
                isFork: true,
                isPrivate: true,
                nameWithOwner: "octocat/dotfiles",
                sshUrl: "git@github.com:octocat/dotfiles.git",
                stargazerCount: 0,
                url: "https://github.com/octocat/dotfiles",
              },
            ]),
          ),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                description: "Another take on codething",
                isFork: true,
                fullName: "acme/codething-tools",
                isPrivate: false,
                stargazersCount: 900,
                url: "https://github.com/acme/codething-tools",
              },
              {
                description: "",
                isFork: false,
                fullName: "octocat/codething-mvp",
                isPrivate: false,
                stargazersCount: 42,
                url: "https://github.com/octocat/codething-mvp",
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      expect(mockRun).toHaveBeenCalledTimes(2);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "repo",
          "list",
          "--json",
          "nameWithOwner,url,sshUrl,stargazerCount,isFork,isPrivate,description",
          "--limit",
          "100",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "search",
          "repos",
          "codething",
          "--json",
          "fullName,url,stargazersCount,isFork,description,isPrivate",
          "--limit",
          "20",
          "--sort",
          "stars",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });

      // Owned repositories keep gh's `stargazerCount`/`sshUrl`; search results
      // report `stargazersCount` and carry no ssh URL at all.
      assert.deepStrictEqual(results, [
        {
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
          ownedByViewer: true,
          description: "Minimal GUI for coding agents",
          starCount: 42,
          isFork: false,
          isPrivate: false,
        },
        {
          nameWithOwner: "acme/codething-tools",
          url: "https://github.com/acme/codething-tools",
          sshUrl: "git@github.com:acme/codething-tools.git",
          ownedByViewer: false,
          description: "Another take on codething",
          starCount: 900,
          isFork: true,
          isPrivate: false,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("strips shell metacharacters and spaces from the query before it reaches argv", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({
        cwd: "/repo",
        query: "foo; rm -rf ~ && echo `id`",
      });

      const searchArgs = mockRun.mock.calls[1]?.[0]?.args;
      assert.deepStrictEqual(searchArgs, [
        "search",
        "repos",
        "foorm-rfechoid",
        "--json",
        "fullName,url,stargazersCount,isFork,description,isPrivate",
        "--limit",
        "20",
        "--sort",
        "stars",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never lets a query become a gh flag", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "--limit 9999" });

      assert.strictEqual(mockRun.mock.calls[1]?.[0]?.args?.[2], "limit9999");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("caps the query length", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "a".repeat(500) });

      assert.strictEqual(mockRun.mock.calls[1]?.[0]?.args?.[2], "a".repeat(128));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs no gh command when the query sanitizes to nothing", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "!!! ???" });

      assert.deepStrictEqual(results, []);
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("dedups an owned repository against a search row that disagrees on casing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                description: "Minimal GUI for coding agents",
                isFork: false,
                isPrivate: false,
                nameWithOwner: "Octocat/CodeThing-MVP",
                sshUrl: "git@github.com:Octocat/CodeThing-MVP.git",
                stargazerCount: 42,
                url: "https://github.com/Octocat/CodeThing-MVP",
              },
            ]),
          ),
        ),
      );
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                description: "Minimal GUI for coding agents",
                isFork: false,
                fullName: "octocat/codething-mvp",
                isPrivate: false,
                stargazersCount: 42,
                url: "https://github.com/octocat/codething-mvp",
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(
        results.map((result) => result.nameWithOwner),
        ["Octocat/CodeThing-MVP"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("degrades to local matches when gh returns unusable search JSON", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("not json")));

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      expect(mockRun).toHaveBeenCalledTimes(2);
      assert.deepStrictEqual(results, []);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("reuses the owned repository listing for a minute of typing", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });
      yield* TestClock.adjust("59 seconds");
      yield* gh.searchRepositories({ cwd: "/repo", query: "codethings" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos", "search repos"]);

      yield* TestClock.adjust("2 seconds");
      yield* gh.searchRepositories({ cwd: "/repo", query: "codethingy" });

      assert.deepStrictEqual(spawnedSubcommands(), [
        "repo list",
        "search repos",
        "search repos",
        "repo list",
        "search repos",
      ]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("serves a repeated query from the search cache", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });
      yield* TestClock.adjust("29 seconds");
      yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos"]);

      yield* TestClock.adjust("2 seconds");
      yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos", "search repos"]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("shares one gh request between concurrent identical searches", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      mockRun.mockImplementation(() =>
        Deferred.await(release).pipe(Effect.as(processOutput("[]"))),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const search = gh.searchRepositories({ cwd: "/repo", query: "codething" });
      const first = yield* Effect.forkChild(search, { startImmediately: true });
      const second = yield* Effect.forkChild(search, { startImmediately: true });

      // Both callers are in flight, yet only one repo listing has spawned.
      expect(mockRun).toHaveBeenCalledTimes(1);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos"]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("ages a cached listing from fetch completion, not fetch start", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        input.args[0] === "repo"
          ? Effect.sleep("30 seconds").pipe(Effect.as(processOutput("[]")))
          : Effect.succeed(processOutput("[]")),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const first = yield* Effect.forkChild(
        gh.searchRepositories({ cwd: "/repo", query: "codething" }),
        { startImmediately: true },
      );
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(first);

      // 45 seconds after the listing landed, 75 after it was asked for. A
      // listing stamped at fetch start would wrongly count as expired here.
      yield* TestClock.adjust("45 seconds");
      yield* gh.searchRepositories({ cwd: "/repo", query: "codethings" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos", "search repos"]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("never spends a search request on a two-character query", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "co" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list"]);

      yield* gh.searchRepositories({ cwd: "/repo", query: "cod" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos"]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("asks GitHub only when the viewer's own repositories do not fill the list", () =>
    Effect.gen(function* () {
      const ownedFor = (count: number) =>
        JSON.stringify(
          Array.from({ length: count }, (_, index) =>
            ownedRepository(`octocat/codething-${index}`),
          ),
        );
      mockRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "search" ? "[]" : ownedFor(input.cwd === "/five" ? 5 : 4),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/five", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list"]);

      yield* gh.searchRepositories({ cwd: "/four", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "repo list", "search repos"]);
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("keeps local matches when the global search fails", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        input.args[0] === "repo"
          ? Effect.succeed(
              processOutput(JSON.stringify([ownedRepository("octocat/codething-mvp")])),
            )
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitHubCli.execute",
                command: "gh",
                cwd: "/repo",
                exitCode: 1,
                failureKind: "rate-limited",
                detail: "API rate limit exceeded.",
                stderrLength: 82,
                stderrTruncated: false,
              }),
            ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos"]);
      assert.deepStrictEqual(
        results.map((result) => result.nameWithOwner),
        ["octocat/codething-mvp"],
      );
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("serves the stale cached search when a refresh fails", () =>
    Effect.gen(function* () {
      let searchCalls = 0;
      mockRun.mockImplementation((input) => {
        if (input.args[0] === "repo") {
          return Effect.succeed(processOutput("[]"));
        }
        searchCalls += 1;
        return Effect.succeed(
          processOutput(
            searchCalls === 1
              ? `[{ "fullName": "acme/codething-tools", "url": "https://github.com/acme/codething-tools" }]`
              : "not json",
          ),
        );
      });

      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      // The cached search rows are 31 seconds old, past their 30 second TTL,
      // and the refresh comes back unusable. The stale rows still answer.
      yield* TestClock.adjust("31 seconds");
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos", "search repos"]);
      assert.deepStrictEqual(
        results.map((result) => result.nameWithOwner),
        ["acme/codething-tools"],
      );
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("runs no gh command while the GitHub circuit is open", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const key = { provider: "github" as const, host: "github.com" };
      const lease = yield* limits.check(key);
      yield* limits.recordRateLimit({ ...key, lease });

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(results, []);
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("opens the circuit when gh reports a GitHub rate limit", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubCli.execute",
            command: "gh",
            cwd: "/repo",
            exitCode: 1,
            failureKind: "rate-limited",
            detail: "API rate limit exceeded.",
            stderrLength: 82,
            stderrTruncated: false,
          }),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .searchRepositories({ cwd: "/repo", query: "codething" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliRateLimitError");

      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const paused = yield* Effect.flip(limits.check({ provider: "github", host: "github.com" }));
      assert.strictEqual(paused._tag, "SourceControlRateLimitPausedError");
    }).pipe(Effect.provide(searchLayer)),
  );

  it.effect("keeps searching while another subsystem's github circuit is paused", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("[]")));
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const key = { provider: "github" as const, host: "github.com" };
      const lease = yield* limits.check(key);
      yield* limits.recordRateLimit({ ...key, lease });

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(results, []);
      assert.deepStrictEqual(spawnedSubcommands(), ["repo list", "search repos"]);
    }).pipe(Effect.provide(sharedCircuitLayer)),
  );

  it.effect("marks a searched repository the capped listing missed as the viewer's own", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        input.args[0] === "repo"
          ? Effect.succeed(processOutput(JSON.stringify([ownedRepository("octocat/unrelated")])))
          : Effect.succeed(
              processOutput(
                JSON.stringify([
                  {
                    fullName: "Octocat/codething-mvp",
                    url: "https://github.com/octocat/codething-mvp",
                  },
                  {
                    fullName: "acme/codething-tools",
                    url: "https://github.com/acme/codething-tools",
                  },
                ]),
              ),
            ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(
        results.map((result) => [result.nameWithOwner, result.ownedByViewer]),
        [
          ["Octocat/codething-mvp", true],
          ["acme/codething-tools", false],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("omits an empty description instead of forwarding it", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        input.args[0] === "repo"
          ? Effect.succeed(processOutput("[]"))
          : Effect.succeed(
              processOutput(
                JSON.stringify([
                  {
                    fullName: "acme/codething-tools",
                    url: "https://github.com/acme/codething-tools",
                    description: "",
                  },
                ]),
              ),
            ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const results = yield* gh.searchRepositories({ cwd: "/repo", query: "codething" });

      assert.deepStrictEqual(results, [
        {
          nameWithOwner: "acme/codething-tools",
          url: "https://github.com/acme/codething-tools",
          sshUrl: "git@github.com:acme/codething-tools.git",
          ownedByViewer: false,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
