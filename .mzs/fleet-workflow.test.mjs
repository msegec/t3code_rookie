import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

NodeTest.test("legacy hosted workflow fails clearly without building or uploading", () => {
  const workflow = NodeFS.readFileSync(
    new URL("../.github/workflows/mzs-fleet-build.yml", import.meta.url),
    "utf8",
  );
  NodeAssert.match(workflow, /on:\n  workflow_dispatch:/);
  NodeAssert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  NodeAssert.match(workflow, /permissions: \{\}/);
  NodeAssert.match(workflow, /timeout-minutes: 1/);
  NodeAssert.match(workflow, /t3-fleet-release build-local/);
  NodeAssert.match(workflow, /exit 1/);
  NodeAssert.doesNotMatch(workflow, /uses:|gh release|npm pack|vp run/);
});
