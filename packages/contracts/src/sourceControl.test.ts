import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SourceControlRepositorySearchInput,
  SourceControlRepositorySearchOutput,
  SourceControlRepositorySearchResult,
} from "./sourceControl.ts";

const decodeSearchResult = Schema.decodeUnknownSync(SourceControlRepositorySearchResult);
const decodeSearchInput = Schema.decodeUnknownSync(SourceControlRepositorySearchInput);
const decodeSearchOutput = Schema.decodeUnknownSync(SourceControlRepositorySearchOutput);

describe("SourceControlRepositorySearchResult", () => {
  it("decodes a repository the viewer owns", () => {
    const parsed = decodeSearchResult({
      nameWithOwner: "pingdotgg/t3code",
      url: "https://github.com/pingdotgg/t3code",
      sshUrl: "git@github.com:pingdotgg/t3code.git",
      ownedByViewer: true,
      description: "A minimal GUI for coding agents",
      starCount: 1234,
      isFork: false,
      isPrivate: false,
    });

    expect(parsed.nameWithOwner).toBe("pingdotgg/t3code");
    expect(parsed.ownedByViewer).toBe(true);
    expect(parsed.starCount).toBe(1234);
  });

  it("leaves the optional metadata undefined when the provider omits it", () => {
    const parsed = decodeSearchResult({
      nameWithOwner: "octocat/hello-world",
      url: "https://github.com/octocat/hello-world",
      sshUrl: "git@github.com:octocat/hello-world.git",
      ownedByViewer: false,
    });

    expect(parsed.description).toBeUndefined();
    expect(parsed.starCount).toBeUndefined();
    expect(parsed.isFork).toBeUndefined();
    expect(parsed.isPrivate).toBeUndefined();
  });

  it("rejects a result without nameWithOwner", () => {
    expect(() =>
      decodeSearchResult({
        url: "https://github.com/octocat/hello-world",
        sshUrl: "git@github.com:octocat/hello-world.git",
        ownedByViewer: false,
      }),
    ).toThrow();
  });
});

describe("SourceControlRepositorySearchInput", () => {
  it("decodes a query without a cwd", () => {
    const parsed = decodeSearchInput({ provider: "github", query: "t3code" });

    expect(parsed.provider).toBe("github");
    expect(parsed.query).toBe("t3code");
    expect(parsed.cwd).toBeUndefined();
  });

  it("decodes a query scoped to a working directory", () => {
    const parsed = decodeSearchInput({ provider: "github", query: "t3code", cwd: "/repo" });

    expect(parsed.cwd).toBe("/repo");
  });
});

describe("SourceControlRepositorySearchOutput", () => {
  it("decodes an unsupported provider as data instead of an error", () => {
    const parsed = decodeSearchOutput({ supported: false, results: [] });

    expect(parsed.supported).toBe(false);
    expect(parsed.results).toEqual([]);
  });

  it("decodes supported results", () => {
    const parsed = decodeSearchOutput({
      supported: true,
      results: [
        {
          nameWithOwner: "pingdotgg/t3code",
          url: "https://github.com/pingdotgg/t3code",
          sshUrl: "git@github.com:pingdotgg/t3code.git",
          ownedByViewer: true,
        },
      ],
    });

    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.nameWithOwner).toBe("pingdotgg/t3code");
  });
});
