import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/mzs-fleet-build.yml", import.meta.url),
  "utf8",
);

NodeTest.test("release jobs use immutable actions and the tested toolchain", () => {
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  NodeAssert.equal(actions.length, 7);
  for (const action of actions) NodeAssert.match(action, /@[a-f0-9]{40}$/);
  NodeAssert.match(workflow, /FLEET_NODE_VERSION: 24\.21\.0/);
  NodeAssert.match(workflow, /FLEET_VP_VERSION: 0\.3\.1/);
  const setup = [
    ...workflow.matchAll(
      /uses: voidzero-dev\/setup-vp@[^\n]+\n        with:\n([\s\S]*?)(?=\n      -|$)/g,
    ),
  ];
  NodeAssert.equal(setup.length, 4);
  for (const [index, match] of setup.entries()) {
    NodeAssert.match(match[1], /version: \$\{\{ env.FLEET_VP_VERSION \}\}/);
    NodeAssert.match(match[1], /node-version: \$\{\{ env.FLEET_NODE_VERSION \}\}/);
    if (index < 3) NodeAssert.match(match[1], /working-directory: source/);
  }
});

NodeTest.test(
  "release concurrency preserves running work and publication uses verified assets",
  () => {
    NodeAssert.match(workflow, /group: mzs-t3-fleet-build\n  cancel-in-progress: false/);
    NodeAssert.match(workflow, /Fleet release already exists:/);
    NodeAssert.match(workflow, /release-notes\.md mzs-fleet\.json >SHA256SUMS/);
    NodeAssert.match(workflow, /node \.mzs\/publish-release\.mjs/);
    NodeAssert.doesNotMatch(workflow, /gh release create/);
  },
);

NodeTest.test("release jobs write no Actions artifacts or caches", () => {
  NodeAssert.doesNotMatch(
    workflow,
    /actions\/(?:cache|upload-artifact|download-artifact)@|cache: true|retention-days:|actions\/(?:artifacts|caches)/,
  );
  NodeAssert.equal([...workflow.matchAll(/cache: false/g)].length, 4);
  NodeAssert.deepEqual(
    [...workflow.matchAll(/runs-on: (.+)/g)].map((match) => match[1]),
    ["ubuntu-24.04", "macos-15", "ubuntu-24.04", "ubuntu-24.04"],
  );
  NodeAssert.match(workflow, /on:\n  workflow_dispatch:/);
  NodeAssert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  const jobs = [...workflow.matchAll(/^  (\w+):\n((?:    .*\n|\n)+)/gm)].filter(
    ([, , body]) => body.includes("    runs-on:"),
  );
  NodeAssert.deepEqual(
    jobs.map(([, name]) => name),
    ["build", "build_macos", "build_linux", "publish"],
  );
  NodeAssert.match(
    jobs[0][2],
    /^    if: \$\{\{ github\.event\.repository\.visibility == 'public' \}\}$/m,
  );
  for (const [, , body] of jobs.slice(1)) {
    NodeAssert.match(body, /^    needs: (?:build|\[build, build_macos, build_linux\])$/m);
    NodeAssert.doesNotMatch(body, /^    if:/m);
  }
});

NodeTest.test(
  "staging uses approved controls, separated producer outputs and success-only cleanup",
  () => {
    NodeAssert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 3);
    NodeAssert.equal([...workflow.matchAll(/ref: \$\{\{ inputs.controls_sha \}\}/g)].length, 3);
    NodeAssert.equal([...workflow.matchAll(/contents: write/g)].length, 4);
    NodeAssert.match(workflow, /mac_arm64: \$\{\{ steps.transport.outputs.mac_arm64 \}\}/);
    NodeAssert.match(workflow, /mac_x64: \$\{\{ steps.transport.outputs.mac_x64 \}\}/);
    NodeAssert.match(workflow, /inventory_key: mac_arm64/);
    NodeAssert.match(workflow, /inventory_key: mac_x64/);
    NodeAssert.match(
      workflow,
      /FLEET_BUILD_ATTEMPT: \$\{\{ needs.build.outputs.build_attempt \}\}/,
    );
    const publication = workflow.indexOf("node .mzs/publish-release.mjs");
    NodeAssert.ok(
      publication > 0 && publication < workflow.indexOf("release-transport.mjs cleanup"),
    );
    NodeAssert.doesNotMatch(workflow, /always\(\)|--clobber|--cleanup-tag/);
    NodeAssert.match(workflow, /Final release was published; staging draft/);
    NodeAssert.match(workflow, /git rev-parse HEAD/);
  },
);

NodeTest.test("desktop jobs verify and reuse the composed server before building the shell", () => {
  for (const job of ["build_macos", "build_linux"]) {
    const body = workflow.split(`  ${job}:\n`)[1].split(/\n  \w+:\n/)[0];
    NodeAssert.ok(body.indexOf("shasum -a 256 --check SHA256SUMS") < body.indexOf("git clone"));
    NodeAssert.match(
      body,
      /tar -xzf "\.\.\/fleet-input\/t3-\$\{\{ needs.build.outputs.version \}\}\.tgz"/,
    );
    NodeAssert.match(body, /--exclude=package\/dist\/resource-monitor/);
    NodeAssert.match(
      body,
      /cmp \.\.\/fleet-input\/mzs-fleet.json apps\/server\/dist\/mzs-fleet.json/,
    );
    NodeAssert.match(body, /node scripts\/build-preview-annotation-css.mjs\n            vp pack/);
    NodeAssert.doesNotMatch(body, /vp run build:desktop|T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR/);
    NodeAssert.match(body, /vp run dist:desktop:artifact/);
    NodeAssert.match(
      body,
      /\.controlsSha == \$controls and \.releaseTag == \$tag and \.version == \$version/,
    );
    NodeAssert.ok(body.indexOf("release-transport.mjs download") < body.indexOf("git clone"));
    NodeAssert.ok(body.indexOf(".controlsSha ==") < body.indexOf("vp i --frozen-lockfile"));
  }
});

NodeTest.test("queued release checks out the approved immutable controls", () => {
  NodeAssert.match(workflow, /\[\[ "\$controls_sha" == "\$GITHUB_SHA" \]\]/);
  const fetch = workflow.indexOf('git -C source fetch --no-tags origin "$controls_sha"');
  const checkout = workflow.indexOf('git -C source checkout --detach "$controls_sha"');
  const verify = workflow.indexOf('[[ "$(git -C source rev-parse HEAD)" == "$controls_sha" ]]');
  NodeAssert.ok(fetch > 0 && checkout > fetch && verify > checkout);
});
