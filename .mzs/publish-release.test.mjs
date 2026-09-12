import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "publish-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const release = NodePath.join(root, "release");
  NodeFS.mkdirSync(release);
  const files = [
    "release-notes.md",
    "t3-1.0.tgz",
    "t3-source-1.0.bundle",
    "nightly-mac.yml",
    "nightly-mac-arm64.yml",
    "nightly-mac-x64.yml",
    "test.dmg",
    "test.zip",
    "test.AppImage",
    "nightly-linux.yml",
  ];
  for (const file of files) NodeFS.writeFileSync(NodePath.join(release, file), `content ${file}`);
  NodeFS.writeFileSync(
    NodePath.join(release, "mzs-fleet.json"),
    JSON.stringify({ version: "1.0", releaseTag: "fleet-1.0" }),
  );
  const checksum = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(release, files[0])))
    .digest("hex");
  for (const file of [
    "SHA256SUMS",
    "SHA256SUMS.mac.arm64",
    "SHA256SUMS.mac.x64",
    "SHA256SUMS.linux.x64",
  ])
    NodeFS.writeFileSync(NodePath.join(release, file), `${checksum}  ${files[0]}\n`);
  const state = NodePath.join(root, "state.json");
  NodeFS.writeFileSync(state, JSON.stringify({ release: null, writes: [] }));
  const mock = NodePath.join(root, "gh");
  NodeFS.writeFileSync(
    mock,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const file = process.env.MOCK_STATE;
const state = JSON.parse(fs.readFileSync(file));
const value = key => args[args.indexOf(key) + 1];
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if(args[0] === 'release' && args[1] === 'view') {
  if(!state.release) {process.stderr.write('release not found'); process.exit(1);}
  process.stdout.write(JSON.stringify({databaseId: 42}));
} else if(args[0] === 'api' && args[1] === '--method') {
  const id = Number(args[3].split('/').at(-1));
  const asset = state.release.assets.find(asset => asset.id === id);
  state.release.assets = state.release.assets.filter(asset => asset.id !== id);
  state.writes.push('delete:' + asset.name); save();
} else if(args[0] === 'api' && args[1].includes('/git/')) {
  process.stdout.write(JSON.stringify({object: {type: 'commit', sha: process.env.TAG_SHA || 'a'.repeat(40)}}));
} else if(args[0] === 'api') {
  if(args[1].includes('/releases/tags/')) process.exit(10);
  if(!state.release) {process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1);}
  process.stdout.write(JSON.stringify(state.release));
} else if(args[1] === 'create') {
  state.release = {tag_name: args[2], target_commitish: value('--target'), name: value('--title'), body: fs.readFileSync(value('--notes-file'), 'utf8'), prerelease: true, draft: true, assets: []};
  state.writes.push('create'); save();
} else if(args[1] === 'upload') {
  const name = path.basename(args[3]);
  if(name === process.env.FAIL_ASSET) process.exit(2);
  const bytes = fs.readFileSync(args[3]);
  state.release.assets.push({name, size: bytes.length, state: 'uploaded', digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')});
  state.writes.push('upload:' + name); save();
} else if(args[1] === 'edit') {
  if(process.env.FAIL_PUBLISH) process.exit(3);
  state.release.draft = false; state.release.body = fs.readFileSync(value('--notes-file'), 'utf8'); state.writes.push('publish'); save();

} else if(args[1] === 'download') {
  fs.copyFileSync(path.join(process.env.MOCK_RELEASE, value('--pattern')), path.join(value('--dir'), value('--pattern')));
} else process.exit(9);
`,
  );
  NodeFS.chmodSync(mock, 0o755);
  return {
    release,
    get: () => JSON.parse(NodeFS.readFileSync(state)),
    set: (value) => NodeFS.writeFileSync(state, JSON.stringify(value)),
    run: (env = {}) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [
          new URL("./publish-release.mjs", import.meta.url).pathname,
          release,
          "test/repo",
          "fleet-1.0",
          "1.0",
          "a".repeat(40),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            MOCK_STATE: state,
            MOCK_RELEASE: release,
            ...env,
          },
        },
      ),
  };
}

NodeTest.test("publishes a verified draft and an identical rerun performs no writes", (t) => {
  const f = fixture(t);
  const result = f.run();
  NodeAssert.equal(result.status, 0, result.stderr);
  const state = f.get();
  NodeAssert.equal(state.release.draft, false);
  NodeAssert.equal(state.writes.at(-1), "publish");
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.deepEqual(f.get(), state);
});

NodeTest.test("partial upload remains a draft and resumes without replacing assets", (t) => {
  const f = fixture(t);
  NodeAssert.notEqual(f.run({ FAIL_ASSET: "nightly-mac.yml" }).status, 0);
  NodeAssert.equal(f.get().release.draft, true);
  const existing = f.get().release.assets.length;
  NodeAssert.ok(existing > 0);
  const result = f.run();
  NodeAssert.equal(result.status, 0, result.stderr);
  const uploads = f.get().writes.filter((entry) => entry.startsWith("upload:"));
  NodeAssert.equal(new Set(uploads).size, uploads.length);
});

NodeTest.test(
  "rejects changed local identity and incompatible remote bytes without mutation",
  (t) => {
    const f = fixture(t);
    NodeAssert.equal(f.run().status, 0);
    const state = f.get();
    state.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
    f.set(state);
    NodeAssert.notEqual(f.run().status, 0);
    NodeAssert.deepEqual(f.get(), state);
    NodeFS.writeFileSync(NodePath.join(f.release, "nightly-mac.yml"), "changed");
    NodeAssert.match(f.run().stderr, /Remote digest mismatch/);
    NodeAssert.deepEqual(f.get(), state);
  },
);

NodeTest.test("verifies downloads when GitHub omits asset digests", (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.run().status, 0);
  const state = f.get();
  delete state.release.assets[0].digest;
  f.set(state);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.deepEqual(f.get(), state);
});

NodeTest.test("rejects damaged input before creating a release", (t) => {
  const f = fixture(t);
  NodeFS.writeFileSync(NodePath.join(f.release, "release-notes.md"), "damaged");
  NodeAssert.match(f.run().stderr, /Invalid checksum/);
  NodeAssert.deepEqual(f.get().writes, []);
});

NodeTest.test("refuses a preexisting tag targeting different controls before any writes", (t) => {
  const f = fixture(t);
  NodeAssert.match(f.run({ TAG_SHA: "b".repeat(40) }).stderr, /tag does not match controls/);
  NodeAssert.deepEqual(f.get().writes, []);
});

NodeTest.test("publication preserves release notes artifact exactly", (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.equal(
    f.get().release.body,
    NodeFS.readFileSync(NodePath.join(f.release, "release-notes.md"), "utf8"),
  );
});

NodeTest.test("failed publication resumes complete draft without uploading again", (t) => {
  const f = fixture(t);
  NodeAssert.notEqual(f.run({ FAIL_PUBLISH: "1" }).status, 0);
  const uploads = f.get().writes.filter((entry) => entry.startsWith("upload:"));
  NodeAssert.equal(f.get().release.draft, true);
  NodeAssert.equal(f.run().status, 0);
  NodeAssert.deepEqual(
    f.get().writes.filter((entry) => entry.startsWith("upload:")),
    uploads,
  );
});

NodeTest.test("resumes only an expected empty starter asset in an identical draft", (t) => {
  const f = fixture(t);
  NodeAssert.notEqual(f.run({ FAIL_ASSET: "nightly-mac.yml" }).status, 0);
  const state = f.get();
  state.release.assets.push({ id: 99, name: "nightly-mac.yml", size: 0, state: "starter" });
  f.set(state);
  const result = f.run();
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.deepEqual(
    f.get().writes.filter((entry) => entry.startsWith("delete:")),
    ["delete:nightly-mac.yml"],
  );
});

NodeTest.test("refuses changed draft identity before recovering starter assets", (t) => {
  const f = fixture(t);
  NodeAssert.notEqual(f.run({ FAIL_ASSET: "nightly-mac.yml" }).status, 0);
  const state = f.get();
  state.release.assets.push({ id: 99, name: "nightly-mac.yml", size: 0, state: "starter" });
  f.set(state);
  NodeFS.writeFileSync(NodePath.join(f.release, "nightly-mac.yml"), "changed");
  NodeAssert.match(f.run().stderr, /incompatible immutable identity/);
  NodeAssert.deepEqual(f.get(), state);
});

for (const asset of [
  { id: 99, name: "unknown.zip", size: 0, state: "starter" },
  { id: 99, name: "nightly-mac.yml", size: 3, state: "starter" },
]) {
  NodeTest.test(`preserves incompatible starter ${asset.name} size ${asset.size}`, (t) => {
    const f = fixture(t);
    NodeAssert.notEqual(f.run({ FAIL_ASSET: "nightly-mac.yml" }).status, 0);
    const state = f.get();
    state.release.assets.push(asset);
    f.set(state);
    NodeAssert.match(f.run().stderr, /Incompatible remote asset/);
    NodeAssert.deepEqual(f.get(), state);
  });
}
