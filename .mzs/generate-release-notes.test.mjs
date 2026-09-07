import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { generateReleaseNotes } from "./generate-release-notes.mjs";

const manifest = {
  base: { tag: "v0.0.39-nightly.20260907.1325", sha: "base" },
  overlays: [{ kind: "commit", name: "Cursor fixes", sha: "abc", action: "applied" }],
};
const config = {
  overlays: [
    { kind: "commit", name: "Cursor fixes", sha: "abc", repository: "msegec/t3code_rookie" },
  ],
  trackedPullRequests: [12, 13, 14],
};
const run = (command, args) => {
  const endpoint = args.at(-1);
  if (endpoint.includes("compare/")) {
    NodeAssert.match(endpoint, /compare\/base\.\.\./);
    return JSON.stringify({
      status: endpoint.endsWith("merged12?per_page=1") ? "behind" : "ahead",
    });
  }
  if (endpoint.includes("releases/tags/"))
    return JSON.stringify({ tag_name: manifest.base.tag, body: "## Fixes\n\n- Official fix" });
  const number = Number(endpoint.split("/").at(-1));
  return JSON.stringify({
    number,
    title: `PR ${number}`,
    state: number === 14 ? "open" : "closed",
    merged_at: number === 14 ? null : "today",
    merge_commit_sha: `merged${number}`,
    head: { sha: `head${number}` },
  });
};

NodeTest.test(
  "preserves exact base notes and separates merge status from base inclusion and actual stack",
  () => {
    const notes = generateReleaseNotes(manifest, config, run);
    NodeAssert.ok(notes.includes("## Fixes\n\n- Official fix"));
    NodeAssert.ok(notes.indexOf("Official fix") < notes.indexOf("Our pull requests"));
    NodeAssert.match(notes, /#12.*Merged upstream; included in this base/);
    NodeAssert.match(notes, /#13.*Merged upstream; not included in this base/);
    NodeAssert.match(notes, /#14.*Open upstream; not included in this base/);
    NodeAssert.match(notes, /Cursor fixes.*msegec\/t3code_rookie\/commit\/abc/);
  },
);

NodeTest.test("omits overlays already included and explains an empty upstream body", () => {
  const notes = generateReleaseNotes({ ...manifest, overlays: [] }, { overlays: [] }, () =>
    JSON.stringify({ tag_name: manifest.base.tag, body: "" }),
  );
  NodeAssert.match(notes, /did not publish release notes/);
  NodeAssert.match(notes, /No additional overlays/);
});

NodeTest.test("fails on API failures, mismatched base release and broken ancestry checks", () => {
  NodeAssert.throws(
    () =>
      generateReleaseNotes(manifest, config, () => {
        throw new Error("API unavailable");
      }),
    /API unavailable/,
  );
  NodeAssert.throws(
    () =>
      generateReleaseNotes(manifest, config, () => JSON.stringify({ tag_name: "wrong", body: "" })),
    /release tag/,
  );
  NodeAssert.throws(
    () =>
      generateReleaseNotes(manifest, config, (command, args) => {
        if (args.at(-1).includes("compare/")) throw new Error("bad object");
        return run(command, args);
      }),
    /bad object/,
  );
});

NodeTest.test(
  "deduplicates tracked overlay PRs and excludes included overlays from the extra stack",
  () => {
    const notes = generateReleaseNotes(
      {
        ...manifest,
        overlays: [{ kind: "pull-request", number: 14, sha: "head14", action: "included" }],
      },
      { ...config, trackedPullRequests: [14, 14] },
      (command, args) => {
        if (args.at(-1).endsWith("pulls/14"))
          return JSON.stringify({
            number: 14,
            title: "Closed PR",
            state: "closed",
            merged_at: null,
            head: { sha: "head14" },
          });
        return run(command, args);
      },
    );
    NodeAssert.equal(notes.match(/#14:/g).length, 1);
    NodeAssert.match(notes, /Closed without merge; not included in this base/);
    NodeAssert.match(notes, /No additional overlays/);
  },
);

NodeTest.test("accepts verified compose output with the same notes as packaged provenance", () => {
  const composed = {
    ...manifest,
    overlays: [{ overlay: "Cursor fixes", sha: "abc", action: "applied" }],
  };
  NodeAssert.equal(
    generateReleaseNotes(composed, config, run),
    generateReleaseNotes(manifest, config, run),
  );
});

NodeTest.test("accepts compose PR labels and rejects unresolved composition results", () => {
  const configWithPull = { overlays: [{ kind: "pull-request", number: 14 }] };
  const composed = {
    ...manifest,
    overlays: [{ overlay: "pull-request-14", sha: "head14", action: "applied" }],
  };
  NodeAssert.match(generateReleaseNotes(composed, configWithPull, run), /Stacked: \[PR #14\]/);
  NodeAssert.throws(
    () => generateReleaseNotes({ ...manifest, overlays: [{ action: "conflict" }] }, config, run),
    /Invalid composition action/,
  );
});
