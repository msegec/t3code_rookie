import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/mzs-fleet-build.yml", import.meta.url),
  "utf8",
);

NodeTest.test("release jobs use immutable actions and the tested toolchain", () => {
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  NodeAssert.equal(actions.length, 13);
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

NodeTest.test(
  "desktop caches retain downloads only and isolate platform and dependency inputs",
  () => {
    const caches = [
      ...workflow.matchAll(/name: Cache desktop dependency downloads[\s\S]*?key: ([^\n]+)/g),
    ];
    NodeAssert.equal(caches.length, 2);
    for (const cache of caches) {
      NodeAssert.match(cache[1], /runner.os/);
      NodeAssert.match(cache[1], /runner.arch/);
      NodeAssert.match(cache[1], /FLEET_NODE_VERSION/);
      NodeAssert.match(cache[1], /FLEET_VP_VERSION/);
      NodeAssert.match(cache[1], /source\/pnpm-lock.yaml/);
      NodeAssert.match(cache[1], /source\/native\/resource-monitor\/Cargo.lock/);
      NodeAssert.doesNotMatch(cache[0], /restore-keys:|\/target|node_modules|\/dist/);
    }
    NodeAssert.match(caches[0][1], /matrix.arch/);
    NodeAssert.match(caches[1][1], /-x64-/);
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
  }
});

NodeTest.test("queued release checks out the approved immutable controls", () => {
  NodeAssert.match(workflow, /\[\[ "\$controls_sha" == "\$GITHUB_SHA" \]\]/);
  const fetch = workflow.indexOf('git -C source fetch --no-tags origin "$controls_sha"');
  const checkout = workflow.indexOf('git -C source checkout --detach "$controls_sha"');
  const verify = workflow.indexOf('[[ "$(git -C source rev-parse HEAD)" == "$controls_sha" ]]');
  NodeAssert.ok(fetch > 0 && checkout > fetch && verify > checkout);
});
