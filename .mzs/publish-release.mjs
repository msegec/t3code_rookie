import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { fileHash as hash, verifyCollected } from "./local-build.mjs";

const [directory, repository, tag, version, target, mode, ...extra] = process.argv.slice(2);
const publish = mode === "--publish";
if (
  extra.length ||
  (mode !== undefined && !publish) ||
  !directory ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[\w.-]+$/.test(tag ?? "") ||
  !/^[\w.-]+$/.test(version ?? "") ||
  !/^[a-f0-9]{40}$/.test(target ?? "")
) {
  throw new Error(
    "Usage: publish-release.mjs <release-dir> <owner/repo> <tag> <version> <controls-sha> [--publish]",
  );
}
const root = NodePath.resolve(directory);
const verified = verifyCollected(root);
if (
  verified.plan.fleet.version !== version ||
  verified.plan.fleet.releaseTag !== tag ||
  verified.plan.fleet.controlsSha !== target
)
  throw new Error("Fleet metadata identity mismatch");
const assets = verified.assets.map(({ name, size, sha256 }) => ({
  name,
  size,
  digest: `sha256:${sha256}`,
}));
const identity = NodeCrypto.createHash("sha256")
  .update(JSON.stringify({ repository, tag, version, target, assets }))
  .digest("hex");
const marker = `<!-- mzs-fleet-release:${identity} -->`;
const title = `T3 Code Fleet ${version}`;
const notesBody = NodeFS.readFileSync(NodePath.join(root, "release-notes.md"), "utf8");
const body = `${notesBody.trim()}\n\n${marker}`;
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-publish-"));
const gh = (...args) =>
  NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const getRelease = () => {
  try {
    const { databaseId } = JSON.parse(
      gh("release", "view", tag, "--repo", repository, "--json", "databaseId"),
    );
    if (!Number.isSafeInteger(databaseId) || databaseId < 1)
      throw new Error("Invalid release identifier");
    return JSON.parse(gh("api", `repos/${repository}/releases/${databaseId}`));
  } catch (error) {
    if (String(error.stderr).trim() === "release not found") return null;
    throw error;
  }
};
const verifyTag = (required) => {
  let object;
  try {
    object = JSON.parse(gh("api", `repos/${repository}/git/ref/tags/${tag}`)).object;
  } catch (error) {
    if (!required && String(error.stderr).includes("(HTTP 404)")) return;
    throw error;
  }
  for (let depth = 0; object?.type === "tag" && depth < 3; depth++) {
    object = JSON.parse(gh("api", `repos/${repository}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== "commit" || object.sha !== target)
    throw new Error("Release tag does not match controls commit");
};
const assertIdentity = (release) => {
  if (
    release.tag_name !== tag ||
    release.target_commitish !== target ||
    release.name !== title ||
    release.prerelease !== true ||
    release.body !== (release.draft ? body : notesBody)
  ) {
    throw new Error("Existing release has an incompatible immutable identity");
  }
};
const verifyAssets = (release, complete) => {
  const remote = release.assets;
  if (
    !Array.isArray(remote) ||
    remote.length > 100 ||
    new Set(remote.map((asset) => asset.name)).size !== remote.length
  ) {
    throw new Error("Invalid remote asset inventory");
  }
  for (const asset of remote) {
    const expected = assets.find((entry) => entry.name === asset.name);
    if (
      !complete &&
      release.draft &&
      expected &&
      asset.state === "starter" &&
      asset.size === 0 &&
      Number.isSafeInteger(asset.id) &&
      asset.id > 0
    )
      continue;
    if (!expected || asset.state !== "uploaded" || asset.size !== expected.size)
      throw new Error(`Incompatible remote asset: ${asset.name}`);
    if (asset.digest) {
      if (asset.digest !== expected.digest)
        throw new Error(`Remote digest mismatch: ${asset.name}`);
    } else {
      const download = NodeFS.mkdtempSync(NodePath.join(temporary, "verify-"));
      gh(
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        asset.name,
        "--dir",
        download,
      );
      if (`sha256:${hash(NodePath.join(download, asset.name))}` !== expected.digest)
        throw new Error(`Remote checksum mismatch: ${asset.name}`);
    }
  }
  if (complete && remote.length !== assets.length)
    throw new Error("Remote release asset set is incomplete");
};
try {
  verifyTag(false);
  let release = getRelease();
  if (!release) {
    const notes = NodePath.join(temporary, "notes.md");
    NodeFS.writeFileSync(notes, body);
    gh(
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      target,
      "--draft",
      "--prerelease",
      "--title",
      title,
      "--notes-file",
      notes,
    );
    release = getRelease();
    if (!release) throw new Error("Created draft could not be read back");
  }
  assertIdentity(release);
  verifyAssets(release, !release.draft);
  if (release.draft) {
    for (const asset of release.assets) {
      if (asset.state === "starter") {
        gh("api", "--method", "DELETE", `repos/${repository}/releases/assets/${asset.id}`);
      }
    }
    const existing = new Set(
      release.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name),
    );
    for (const asset of assets) {
      if (!existing.has(asset.name))
        gh("release", "upload", tag, NodePath.join(root, asset.name), "--repo", repository);
    }
    release = getRelease();
    assertIdentity(release);
    if (!release.draft) throw new Error("Release was published concurrently; refusing mutation");
    verifyAssets(release, true);
    verifyTag(false);
    if (publish)
      gh(
        "release",
        "edit",
        tag,
        "--repo",
        repository,
        "--notes-file",
        NodePath.join(root, "release-notes.md"),
        "--draft=false",
      );
    release = getRelease();
    assertIdentity(release);
    if (publish && release.draft) throw new Error("Release is still a draft");
    verifyAssets(release, true);
  }
  verifyTag(!release.draft);
  process.stdout.write(
    `Verified ${release.draft ? "draft" : "published"} release ${repository}@${tag}\n`,
  );
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
