import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const encodeGitHubCliError = Schema.encodeEffect(Schema.fromJsonString(GitHubCli.GitHubCliError));

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const quotaOutput = (remaining = 5000, resetAt = "2099-01-01T00:00:00Z") =>
  processOutput(
    JSON.stringify({ data: { rateLimit: { cost: 1, limit: 5000, remaining, resetAt } } }),
  );

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        input.args[1] === "rate_limit" ? Effect.succeed(quotaOutput()) : mockRun(input),
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
  Layer.provideMerge(GitHubGraphQlBudget.layer),
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

it.effect("shares quota checks, preserves the reserve, and resumes after reset", () =>
  Effect.gen(function* () {
    let probes = 0;
    const commands: string[] = [];
    let remaining = 501;
    let resetAt = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000),
    );
    const gh = yield* GitHubCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          Effect.sync(() => {
            if (input.args[1] === "rate_limit") {
              probes++;
              assert.strictEqual(input.args[3], "enterprise.test");
              return quotaOutput(remaining, resetAt);
            }
            commands.push(input.args.slice(0, 2).join(" "));
            return processOutput("[]");
          }),
      }),
    );
    const read = (command: string) =>
      gh.execute({
        cwd: "/repo",
        args:
          command === "repo"
            ? ["repo", "view", "enterprise.test/acme/web", "--json", "name"]
            : ["pr", command, "--repo=enterprise.test/acme/web", "--json", "number"],
      });
    yield* read("list");
    const failure = yield* read("view").pipe(Effect.flip);
    assert.strictEqual(failure._tag, "GitHubCliRateLimitError");
    assert.strictEqual(probes, 1);
    assert.deepStrictEqual(commands, ["pr list"]);
    yield* read("view").pipe(Effect.provideService(GitHubCli.AllowGitHubReserve, true));
    yield* gh.execute({ cwd: "/repo", args: ["pr", "merge", "1"] });
    assert.deepStrictEqual(commands, ["pr list", "pr view", "pr merge"]);
    remaining = 0;
    yield* TestClock.adjust("30 seconds");
    yield* read("repo").pipe(Effect.flip);
    assert.strictEqual(probes, 2);
    yield* TestClock.adjust("30 seconds");
    remaining = 5000;
    resetAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000));
    yield* Effect.all([read("list"), read("repo")], { concurrency: 2 });
    assert.strictEqual(probes, 3);
    assert.deepStrictEqual(commands.slice(3).toSorted(), ["pr list", "repo view"]);
  }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
);

describe("GitHubCli.layer", () => {
  it.effect("shares the registry budget with CLI reads through nested layer providers", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      const gh = yield* GitHubCli.GitHubCli;
      yield* budget.observe("github.com", quotaOutput(0).stdout);
      const error = yield* gh.execute({ cwd: "/repo", args: ["pr", "list"] }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer.pipe(Layer.provide(GitHubGraphQlBudget.layer)))),
  );

  it.effect("keeps quota snapshots separate for verified credentials on the same host", () =>
    Effect.gen(function* () {
      let reads = 0;
      const gh = yield* GitHubCli.make.pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            Effect.sync(() => {
              if (input.args[1] === "rate_limit")
                return quotaOutput(input.env?.GH_TOKEN === "empty" ? 0 : 5000);
              reads++;
              return processOutput("[]");
            }),
        }),
      );
      const read = (token: string) =>
        gh.execute({ cwd: "/repo", args: ["pr", "list", "--repo", "github.com/acme/web"] }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make(token),
            credentialFingerprint: token,
          }),
        );
      yield* read("empty").pipe(Effect.flip);
      yield* read("healthy");
      yield* read("empty").pipe(Effect.flip);
      assert.strictEqual(reads, 1);
    }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
  );

  it.effect("pins concurrent cached commands to their own verified credentials", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        Effect.succeed(processOutput(input.env?.GH_TOKEN ?? "ambient")),
      );
      const gh = yield* GitHubCli.GitHubCli;
      // Constructed outside either request, like the PR service's read caches.
      const cache = yield* Cache.make({
        lookup: (host: string) =>
          gh.execute({
            cwd: "/repo",
            args: ["api", "user", "--hostname", host],
            env: { GH_DEBUG: "api", GH_TOKEN: "changed-after-verification" },
          }),
        capacity: 2,
        timeToLive: "1 minute",
      });
      const results = yield* Effect.all(
        ["github.com", "github.example.test"].map((host, index) =>
          Cache.get(cache, host).pipe(
            Effect.provideService(GitHubCli.PinnedGitHubCredential, {
              host,
              token: Redacted.make(`credential-${index}`),
              credentialFingerprint: `fingerprint-${index}`,
            }),
          ),
        ),
        { concurrency: 2 },
      );
      expect(results.map((result) => result.stdout)).toEqual(["credential-0", "credential-1"]);
      for (const [input] of mockRun.mock.calls) {
        expect(input.env).toMatchObject({
          GH_HOST: input.args[3],
          GH_DEBUG: "",
          GH_TOKEN: input.env?.GITHUB_TOKEN,
          GH_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
          GITHUB_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
        });
      }
      expect((yield* gh.execute({ cwd: "/repo", args: ["api", "user"] })).stdout).toBe("ambient");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses other or implicit hosts before exposing a scoped credential to gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      for (const args of [
        ["api", "user", "--hostname", "other.example.test"],
        ["api", "user", "--hostname=other.example.test"],
        ["pr", "view", "1", "--repo", "other.example.test/owner/repo"],
        ["repo", "view", "other.example.test/owner/repo", "--json", "name"],
        ["api", "https://other.example.test/user", "--hostname", "github.com"],
        ["api", "user"],
      ]) {
        const failure = yield* gh.execute({ cwd: "/repo", args }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make("secret-credential"),
            credentialFingerprint: "fingerprint",
          }),
          Effect.flip,
        );
        expect(failure._tag).toBe("GitHubCliCommandError");
        expect(yield* encodeGitHubCliError(failure)).not.toContain("secret-credential");
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pins repository-targeted writes on enterprise hosts", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("")));
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["pr", "merge", "1", "--repo", "github.example.test/owner/repo"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["repo", "view", "github.example.test/owner/repo", "--json", "name"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      expect(mockRun.mock.calls[0]?.[0].env).toMatchObject({
        GH_HOST: "github.example.test",
        GH_ENTERPRISE_TOKEN: "enterprise-credential",
        GH_DEBUG: "",
      });
    }).pipe(Effect.provide(layer)),
  );

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
              isDraft: true,
              mergedAt: null,
              updatedAt: "2026-08-24T12:34:56Z",
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
        closedAt: null,
        mergedAt: null,
        isDraft: true,
        updatedAt: "2026-08-24T12:34:56.000Z",
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
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
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
        closedAt: null,
        mergedAt: null,
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
          closedAt: null,
          mergedAt: null,
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
          closedAt: null,
          mergedAt: null,
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
      const paused = yield* gh
        .execute({ cwd: "/other-repo", args: ["pr", "list"] })
        .pipe(Effect.flip);
      assert.strictEqual(paused._tag, "GitHubCliRateLimitError");
      expect(mockRun).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("30 seconds");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      yield* gh.execute({ cwd: "/other-repo", args: ["pr", "list"] });
      expect(mockRun).toHaveBeenCalledTimes(2);
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
