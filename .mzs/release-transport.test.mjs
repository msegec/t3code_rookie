import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "transport-test-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const state = NodePath.join(root, "state.json");
  const output = NodePath.join(root, "output");
  NodeFS.writeFileSync(state, JSON.stringify({ releases: {}, writes: [], nextId: 40 }));
  NodeFS.writeFileSync(
    NodePath.join(root, "gh"),
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE));
const value = key => args[args.indexOf(key) + 1];
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const fail = text => { process.stderr.write(text); process.exit(1); };
const emit = data => process.stdout.write(JSON.stringify(data));
const release = tag => Object.values(state.releases).find(r => r.tag_name === tag);
const create = r => { r.id = state.nextId++; r.assets = []; state.releases[r.id] = r; state.writes.push('create:' + r.tag_name); save(); emit(r); };
const upload = (r, file) => {
 const name = path.basename(file);
 if(name === process.env.FAIL_ASSET) fail('upload failed');
 if(r.assets.some(a => a.name === name)) fail('duplicate upload');
 const bytes = fs.readFileSync(file);
 const asset = {id: state.nextId++, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64')};
 r.assets.push(asset); state.writes.push('upload:' + name); save(); emit(asset);
};
if(args[0] === 'release') {
 const r = release(args[2]);
 if(args[1] === 'view') {
  if(process.env.FAIL_LOOKUP) fail(process.env.FAIL_LOOKUP);
  if(!r) fail('release not found');
  emit({databaseId: state.viewId || r.id});
 } else if(args[1] === 'create') create({tag_name: args[2], target_commitish: value('--target'), name: value('--title'), body: fs.readFileSync(value('--notes-file'), 'utf8'), draft: true, prerelease: true});
 else if(args[1] === 'upload') upload(r, args[3]);
 else if(args[1] === 'edit') {
  if(process.env.FAIL_PUBLISH) fail('publish failed');
  r.draft = false; r.body = fs.readFileSync(value('--notes-file'), 'utf8'); state.writes.push('publish:' + r.tag_name); save();
 } else if(args[1] === 'download') {
  const a = r.assets.find(a => a.name === value('--pattern'));
  fs.writeFileSync(path.join(value('--dir'), a.name), Buffer.from(a.bytes, 'base64'));
 } else fail('unknown release command');
} else if(args[0] === 'api') {
 const method = args.includes('--method') ? value('--method') : 'GET';
 const endpoint = args[1] === '--method' ? args[3] : args[1];
 if(endpoint.includes('/git/')) { emit({object: {type: 'commit', sha: 'a'.repeat(40)}}); process.exit(); }
 const match = endpoint.match(/\/releases(?:\/(assets))?(?:\/(\d+))?/);
 if(!match) fail('unknown endpoint ' + endpoint);
 const id = Number(match[2]);
 const r = state.releases[id];
 if(method === 'POST' && !id) create(JSON.parse(fs.readFileSync(value('--input'))));
 else if(method === 'POST') upload(r, value('--input'));
 else if(method === 'DELETE') {
  if(process.env.FAIL_DELETE) fail('delete failed');
  if(match[1]) { for(const r of Object.values(state.releases)) r.assets = r.assets.filter(a => a.id !== id); }
  else delete state.releases[id];
  state.writes.push('delete:' + id); save();
 } else if(match[1]) {
  const a = Object.values(state.releases).flatMap(r => r.assets).find(a => a.id === id);
  if(!a) fail('missing asset');
  process.stdout.write(Buffer.from(a.bytes, 'base64'));
 } else if(!r) fail('gh: Not Found (HTTP 404)');
 else if(endpoint.includes('/assets?')) emit(endpoint.endsWith('page=2') ? (state.overflow || []) : r.assets);
 else emit(r);
} else fail('unknown command');
`,
  );
  NodeFS.chmodSync(NodePath.join(root, "gh"), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    MOCK_STATE: state,
    GITHUB_REPOSITORY: "test/repo",
    GITHUB_RUN_ID: "123",
    FLEET_BUILD_ATTEMPT: "2",
    FLEET_CONTROLS_SHA: "a".repeat(40),
    FLEET_RELEASE_TAG: "fleet-1.0",
    GITHUB_OUTPUT: output,
  };
  const directory = (name, files) => {
    const path = NodePath.join(root, name);
    NodeFS.mkdirSync(path);
    for (const [name, bytes] of Object.entries(files))
      NodeFS.writeFileSync(NodePath.join(path, name), bytes);
    return path;
  };
  const server = directory("server", {
    "server.tgz": "server bytes",
    "source.bundle": "source bytes",
  });
  const invoke = (script, args, extra = {}) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [new URL(script, import.meta.url).pathname, ...args],
      {
        env: { ...env, ...extra },
        encoding: "utf8",
      },
    );
  const get = () => JSON.parse(NodeFS.readFileSync(state));
  return {
    root,
    env,
    server,
    directory,
    get,
    set: (stateValue) => NodeFS.writeFileSync(state, JSON.stringify(stateValue)),
    output: () =>
      Object.fromEntries(
        NodeFS.readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      ),
    run: (command, dir = server, extra = {}, key = "inventory") =>
      invoke("./release-transport.mjs", [command, dir, key], extra),
    publish: (dir, extra = {}) =>
      invoke(
        "./publish-release.mjs",
        [dir, "test/repo", "fleet-1.0", "1.0", "a".repeat(40)],
        extra,
      ),
    start() {
      const r = this.run("create");
      NodeAssert.equal(r.status, 0, r.stderr);
      env.FLEET_STAGING_ID = this.output().staging_id;
      return JSON.parse(this.output().inventory);
    },
  };
}

NodeTest.test(
  "four producers retain exact bytes through transport and the unchanged publisher",
  (t) => {
    const f = fixture(t);
    NodeFS.rmSync(f.server, { recursive: true });
    const fleet = JSON.stringify({
      version: "1.0",
      releaseTag: "fleet-1.0",
      controlsSha: "a".repeat(40),
    });
    const groups = [
      {
        "mzs-fleet.json": fleet,
        "release-notes.md": "Exact release notes\n",
        "t3-1.0.tgz": "server",
        "t3-source-1.0.bundle": "source",
      },
      { "nightly-mac-arm64.yml": "arm manifest", "arm.dmg": "arm dmg", "arm.zip": "arm zip" },
      { "nightly-mac-x64.yml": "x64 manifest", "x64.dmg": "x64 dmg", "x64.zip": "x64 zip" },
      { "nightly-linux.yml": "linux manifest", "test.AppImage": "linux" },
    ];
    const inventories = [];
    const baseline = {};
    groups.forEach((files, index) => {
      const sumName = [
        "SHA256SUMS",
        "SHA256SUMS.mac.arm64",
        "SHA256SUMS.mac.x64",
        "SHA256SUMS.linux.x64",
      ][index];
      files[sumName] = Object.entries(files)
        .map(
          ([name, bytes]) =>
            `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
        )
        .join("");
      Object.assign(baseline, files);
      const dir = f.directory(`producer-${index}`, files);
      const result = f.run(index ? "upload" : "create", dir, {}, `inventory_${index}`);
      NodeAssert.equal(result.status, 0, result.stderr);
      f.env.FLEET_STAGING_ID = f.output().staging_id;
      inventories.push(JSON.parse(f.output()[`inventory_${index}`]));
    });
    const dir = NodePath.join(f.root, "collected");
    const result = f.run("collect", dir, { FLEET_INVENTORIES: JSON.stringify(inventories) });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.deepEqual(
      Object.fromEntries(
        NodeFS.readdirSync(dir).map((name) => [
          name,
          NodeFS.readFileSync(NodePath.join(dir, name), "utf8"),
        ]),
      ),
      baseline,
    );
    NodeFS.writeFileSync(NodePath.join(dir, "nightly-mac.yml"), "merged manifest");
    NodeAssert.notEqual(f.publish(dir, { FAIL_PUBLISH: "true" }).status, 0);
    const interrupted = f.get();
    NodeAssert.equal(interrupted.releases[f.env.FLEET_STAGING_ID].draft, true);
    NodeAssert.notEqual(f.run("cleanup", dir).status, 0);
    NodeAssert.deepEqual(f.get(), interrupted);
    const published = f.publish(dir);
    NodeAssert.equal(published.status, 0, published.stderr);
    const failedCleanup = f.run("cleanup", dir, { FAIL_DELETE: "true" });
    NodeAssert.notEqual(failedCleanup.status, 0);
    NodeAssert.equal(
      Object.values(f.get().releases).find((r) => r.tag_name === "fleet-1.0").draft,
      false,
    );
    NodeAssert.equal(f.run("cleanup", dir).status, 0);
    NodeAssert.deepEqual(
      Object.values(f.get().releases).map((r) => r.tag_name),
      ["fleet-1.0"],
    );
    NodeAssert.equal(f.get().writes.at(-1), `delete:${f.env.FLEET_STAGING_ID}`);
  },
);

NodeTest.test("partial upload and empty starter resume only in the owned draft", (t) => {
  const f = fixture(t);
  NodeAssert.notEqual(f.run("create", f.server, { FAIL_ASSET: "source.bundle" }).status, 0);
  const state = f.get();
  const release = Object.values(state.releases)[0];
  NodeAssert.equal(release.draft, true);
  release.assets.push({ id: 999, name: "source.bundle", size: 0, state: "starter" });
  f.set(state);
  f.start();
  NodeAssert.equal(f.get().writes.filter((w) => w === "upload:server.tgz").length, 1);
  NodeAssert.ok(f.get().writes.includes("delete:999"));
  const saved = f.get();
  NodeAssert.equal(f.run("create").status, 0);
  NodeAssert.deepEqual(f.get(), saved);
});

for (const field of ["target_commitish", "tag_name", "body", "draft", "id"]) {
  NodeTest.test(`rejects foreign or published staging ${field} without writes`, (t) => {
    const f = fixture(t);
    f.start();
    const state = f.get();
    const release = state.releases[f.env.FLEET_STAGING_ID];
    release[field] = field === "draft" ? false : field === "id" ? 99 : "wrong";
    f.set(state);
    NodeAssert.match(f.run("upload").stderr, /ownership mismatch/);
    NodeAssert.deepEqual(f.get(), state);
  });
}
for (const env of [
  { GITHUB_RUN_ID: "124" },
  { FLEET_BUILD_ATTEMPT: "3" },
  { FLEET_RELEASE_TAG: "wrong" },
  { FLEET_STAGING_ID: "999" },
]) {
  NodeTest.test(`rejects changed run identity ${JSON.stringify(env)}`, (t) => {
    const f = fixture(t);
    f.start();
    const state = f.get();
    NodeAssert.notEqual(f.run("upload", f.server, env).status, 0);
    NodeAssert.deepEqual(f.get(), state);
  });
}

NodeTest.test("auth and network lookup failures never create a draft", (t) => {
  const f = fixture(t);
  for (const error of ["HTTP 403", "network unreachable", "gh: Not Found (HTTP 404)"]) {
    NodeAssert.notEqual(f.run("create", f.server, { FAIL_LOOKUP: error }).status, 0);
    NodeAssert.deepEqual(f.get().writes, []);
  }
});

NodeTest.test("missing API digests verify bytes, including tampered downloads", (t) => {
  const f = fixture(t);
  const entries = f.start();
  let state = f.get();
  const asset = state.releases[f.env.FLEET_STAGING_ID].assets[0];
  delete asset.digest;
  f.set(state);
  NodeAssert.equal(f.run("upload").status, 0);
  asset.bytes = Buffer.from("changed byte").toString("base64");
  f.set(state);
  NodeAssert.match(f.run("upload").stderr, /checksum mismatch/);
  NodeAssert.notEqual(
    f.run("download", NodePath.join(f.root, "download"), {
      FLEET_INVENTORIES: JSON.stringify([entries]),
    }).status,
    0,
  );
  NodeAssert.deepEqual(f.get(), state);
});

for (const change of ["missing", "extra", "duplicate", "starter", "digest", "size", "overflow"]) {
  NodeTest.test(`collect rejects ${change} assets without mutation`, (t) => {
    const f = fixture(t);
    const entries = f.start();
    const state = f.get();
    const assets = state.releases[f.env.FLEET_STAGING_ID].assets;
    if (change === "missing") assets.pop();
    if (change === "extra") assets.push({ ...assets[0], name: "extra", id: 999 });
    if (change === "duplicate") assets.push({ ...assets[0], id: 999 });
    if (change === "starter") Object.assign(assets[0], { state: "starter", size: 0 });
    if (change === "digest") assets[0].digest = `sha256:${"0".repeat(64)}`;
    if (change === "size") assets[0].size++;
    if (change === "overflow") state.overflow = [{ id: 999 }];
    f.set(state);
    NodeAssert.notEqual(
      f.run("collect", NodePath.join(f.root, "download"), {
        FLEET_INVENTORIES: JSON.stringify([entries]),
      }).status,
      0,
    );
    NodeAssert.deepEqual(f.get(), state);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(f.root, "download")), false);
  });
}

NodeTest.test(
  "rejects colliding producer inventories and changed manifest hashes before download",
  (t) => {
    const f = fixture(t);
    const entries = f.start();
    const state = f.get();
    for (const groups of [
      [entries, entries],
      [[{ ...entries[0], digest: `sha256:${"0".repeat(64)}` }]],
    ]) {
      NodeAssert.notEqual(
        f.run("collect", NodePath.join(f.root, "download"), {
          FLEET_INVENTORIES: JSON.stringify(groups),
        }).status,
        0,
      );
      NodeAssert.deepEqual(f.get(), state);
    }
  },
);

NodeTest.test("limits and unsafe local entries stop before remote writes", (t) => {
  const f = fixture(t);
  const many = f.directory(
    "many",
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`file-${i}`, "x"])),
  );
  NodeAssert.notEqual(f.run("create", many).status, 0);
  const unsafe = f.directory("unsafe", { "bad name": "x" });
  NodeAssert.notEqual(f.run("create", unsafe).status, 0);
  const huge = f.directory("huge", {});
  const fd = NodeFS.openSync(NodePath.join(huge, "huge"), "w");
  NodeFS.ftruncateSync(fd, 2 ** 31);
  NodeFS.closeSync(fd);
  NodeAssert.notEqual(f.run("create", huge).status, 0);
  const link = f.directory("link", {});
  NodeFS.symlinkSync(NodePath.join(f.server, "server.tgz"), NodePath.join(link, "link"));
  NodeAssert.notEqual(f.run("create", link).status, 0);
  NodeAssert.deepEqual(f.get().writes, []);
});

NodeTest.test("an unpublished final release cannot trigger staging cleanup", (t) => {
  const f = fixture(t);
  f.start();
  const state = f.get();
  NodeAssert.notEqual(f.run("cleanup").status, 0);
  NodeAssert.deepEqual(f.get(), state);
});

NodeTest.test("mismatched existing upload stops before adding any new file", (t) => {
  const f = fixture(t);
  f.start();
  const state = f.get();
  state.releases[f.env.FLEET_STAGING_ID].assets[0].digest = `sha256:${"0".repeat(64)}`;
  f.set(state);
  NodeFS.writeFileSync(NodePath.join(f.server, "new-file"), "new");
  NodeAssert.notEqual(f.run("upload").status, 0);
  NodeAssert.deepEqual(f.get(), state);
});
