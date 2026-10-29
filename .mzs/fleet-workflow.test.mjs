import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/mzs-fleet-build.yml", import.meta.url),
  "utf8",
);

NodeTest.test("hosted workflow runs only on dispatch in a public repository", () => {
  NodeAssert.match(workflow, /on:\n  workflow_dispatch:/);
  NodeAssert.doesNotMatch(
    workflow,
    /^  (push|pull_request|pull_request_target|schedule|release):/m,
  );
  NodeAssert.match(workflow, /if: \$\{\{ github\.event\.repository\.visibility == 'public' \}\}/);
  NodeAssert.match(workflow, /permissions:\n(?:  #.*\n)*  actions: read\n  contents: read\n\n/);
});

NodeTest.test("hosted workflow builds one pinned source without secrets or publication", () => {
  const sha = workflow.match(/FLEET_SOURCE_SHA: ([a-f0-9]{40})/)?.[1];
  NodeAssert.ok(sha);
  const calls = [
    ...workflow.matchAll(
      /uses: msegec\/t3code_rookie\/\.github\/workflows\/release-desktop\.yml@(\S+)/g,
    ),
  ];
  NodeAssert.equal(calls.length, 6);
  for (const [, ref] of calls) NodeAssert.equal(ref, sha);
  for (const [, action] of workflow.matchAll(/uses: ([^.\s]\S*)/g))
    NodeAssert.match(action, /@[a-f0-9]{40}$/);
  NodeAssert.doesNotMatch(
    workflow,
    /^\s+secrets:|secrets\.|gh release|contents: write|npm publish/m,
  );
  NodeAssert.deepEqual(
    [...workflow.matchAll(/(?:runs-on|runner|verify_runner): (.+)/g)].map((match) => match[1]),
    [
      "ubuntu-24.04",
      "ubuntu-24.04",
      "macos-15",
      "macos-15",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "ubuntu-24.04",
      "windows-2025",
      "ubuntu-24.04",
      "windows-11-arm",
    ],
  );
});
