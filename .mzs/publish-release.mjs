import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const [directory, repository, tag, version, target] = process.argv.slice(2);
if (
  !directory ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[\w.-]+$/.test(tag ?? "") ||
  !/^[\w.-]+$/.test(version ?? "") ||
  !/^[a-f0-9]{40}$/.test(target ?? "")
) {
  throw new Error(
    "Usage: publish-release.mjs <release-dir> <owner/repo> <tag> <version> <controls-sha>",
  );
}
const root = NodePath.resolve(directory);
const hash = (file) => {
  const digest = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = NodeFS.readSync(descriptor, buffer)) > 0)
      digest.update(buffer.subarray(0, size));
    return digest.digest("hex");
  } finally {
    NodeFS.closeSync(descriptor);
  }
};
const names = NodeFS.readdirSync(root).sort();
if (
  names.length > 100 ||
  names.some(
    (name) => !/^[\w.-]+$/.test(name) || !NodeFS.statSync(NodePath.join(root, name)).isFile(),
  )
) {
  throw new Error("Release must contain at most 100 plainly named files");
}
for (const name of [
  "mzs-fleet.json",
  "release-notes.md",
  `t3-${version}.tgz`,
  `t3-source-${version}.bundle`,
  "SHA256SUMS",
  "SHA256SUMS.mac.arm64",
  "SHA256SUMS.mac.x64",
  "SHA256SUMS.linux.x64",
  "nightly-mac.yml",
  "nightly-mac-arm64.yml",
  "nightly-mac-x64.yml",
]) {
  if (!names.includes(name)) throw new Error(`Missing release asset: ${name}`);
}
for (const extension of [".dmg", ".zip", ".AppImage", "-linux.yml"]) {
  if (!names.some((name) => name.endsWith(extension)))
    throw new Error(`Missing release asset: *${extension}`);
}
const fleet = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "mzs-fleet.json"), "utf8"));
if (fleet.version !== version || fleet.releaseTag !== tag)
  throw new Error("Fleet metadata identity mismatch");
for (const name of names.filter((name) => name.startsWith("SHA256SUMS"))) {
  const lines = NodeFS.readFileSync(NodePath.join(root, name), "utf8").trim().split("\n");
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *](?:\.\/)?([\w.-]+)$/.exec(line);
    if (!match || !names.includes(match[2]) || hash(NodePath.join(root, match[2])) !== match[1]) {
      throw new Error(`Invalid checksum in ${name}`);
    }
  }
}
const assets = names.map((name) => ({
  name,
  size: NodeFS.statSync(NodePath.join(root, name)).size,
  digest: `sha256:${hash(NodePath.join(root, name))}`,
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
    if (release.draft) throw new Error("Release is still a draft");
    verifyAssets(release, true);
  }
  verifyTag(true);
  process.stdout.write(`Verified published release ${repository}@${tag}\n`);
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
