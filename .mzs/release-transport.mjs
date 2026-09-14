import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const [command, directory, outputKey = "inventory"] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const controls = process.env.FLEET_CONTROLS_SHA;
const finalTag = process.env.FLEET_RELEASE_TAG;
const run = process.env.GITHUB_RUN_ID;
const attempt = process.env.FLEET_BUILD_ATTEMPT;
if (
  !["create", "upload", "download", "collect", "cleanup"].includes(command) ||
  !directory ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[a-f0-9]{40}$/.test(controls ?? "") ||
  !/^[\w.-]+$/.test(finalTag ?? "") ||
  !/^[1-9][0-9]*$/.test(run ?? "") ||
  !/^[1-9][0-9]*$/.test(attempt ?? "") ||
  !/^[a-z][a-z0-9_]*$/.test(outputKey)
)
  throw new Error("Invalid release transport inputs");
const tag = `mzs-build-${run}-${attempt}`;
if (tag === finalTag) throw new Error("Staging and final tags must differ");
const body = JSON.stringify({ repository, run, attempt, finalTag, controls });
const root = NodePath.resolve(directory);
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transport-"));
const api = `repos/${repository}/releases`;
const gh = (...args) =>
  NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const json = (...args) => JSON.parse(gh(...args));
const hash = (file) => {
  const digest = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = NodeFS.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
    return `sha256:${digest.digest("hex")}`;
  } finally {
    NodeFS.closeSync(fd);
  }
};
const inventory = (entries) => {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 100 ||
    new Set(entries.map((entry) => entry?.name)).size !== entries.length ||
    entries.some(
      (entry) =>
        !/^[\w][\w.-]{0,199}$/.test(entry?.name ?? "") ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 1 ||
        entry.size >= 2 ** 31 ||
        !/^sha256:[a-f0-9]{64}$/.test(entry.digest ?? ""),
    )
  )
    throw new Error("Invalid or colliding transport inventory");
  return entries
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
};
const local = () => {
  const names = NodeFS.readdirSync(root);
  if (
    !names.length ||
    names.length > 100 ||
    names.some((name) => !/^[\w][\w.-]{0,199}$/.test(name))
  )
    throw new Error("Invalid local transport inventory");
  return inventory(
    names.map((name) => {
      const file = NodePath.join(root, name);
      const stat = NodeFS.lstatSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size >= 2 ** 31)
        throw new Error("Invalid local transport file");
      return { name, size: stat.size, digest: hash(file) };
    }),
  );
};
const output = (key, value) =>
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
let id = Number(process.env.FLEET_STAGING_ID);
const read = () => {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid staging release ID");
  const release = json("api", `${api}/${id}`);
  if (
    release.id !== id ||
    release.tag_name !== tag ||
    release.target_commitish !== controls ||
    release.draft !== true ||
    release.prerelease !== true ||
    release.name !== tag ||
    release.body !== body
  )
    throw new Error("Staging release ownership mismatch");
  const assets = json("api", `${api}/${id}/assets?per_page=100&page=1`);
  const overflow = json("api", `${api}/${id}/assets?per_page=100&page=2`);
  if (
    !Array.isArray(assets) ||
    assets.length > 100 ||
    !Array.isArray(overflow) ||
    overflow.length ||
    new Set(assets.map((asset) => asset.name)).size !== assets.length ||
    new Set(assets.map((asset) => asset.id)).size !== assets.length ||
    assets.some((asset) => !Number.isSafeInteger(asset.id) || asset.id < 1)
  )
    throw new Error("Invalid remote transport inventory");
  return assets;
};
const download = (asset, file) => {
  const fd = NodeFS.openSync(file, "wx");
  try {
    NodeChildProcess.execFileSync(
      "gh",
      ["api", `${api}/assets/${asset.id}`, "--header", "Accept: application/octet-stream"],
      {
        timeout: 120_000,
        stdio: ["ignore", fd, "pipe"],
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    NodeFS.closeSync(fd);
  }
};
const verify = (remote, expected, destination) => {
  if (
    remote.state !== "uploaded" ||
    remote.size !== expected.size ||
    (remote.digest && remote.digest !== expected.digest)
  )
    throw new Error(`Changed transport asset: ${expected.name}`);
  if (destination || !remote.digest) {
    const file =
      destination ??
      NodePath.join(NodeFS.mkdtempSync(NodePath.join(temporary, "verify-")), expected.name);
    download(remote, file);
    if (NodeFS.statSync(file).size !== expected.size || hash(file) !== expected.digest)
      throw new Error(`Transport checksum mismatch: ${expected.name}`);
  }
};
const expectedInput = () => {
  const groups = JSON.parse(process.env.FLEET_INVENTORIES ?? "null");
  if (!Array.isArray(groups) || !groups.length || groups.length > 4)
    throw new Error("Invalid producer inventories");
  return inventory(groups.flatMap((group) => inventory(group)));
};
try {
  const expected = ["create", "upload", "cleanup"].includes(command) ? local() : expectedInput();
  if (command === "create") {
    try {
      id = json("release", "view", tag, "--repo", repository, "--json", "databaseId").databaseId;
    } catch (error) {
      if (String(error.stderr).trim() !== "release not found") throw error;
      const request = NodePath.join(temporary, "create.json");
      NodeFS.writeFileSync(
        request,
        JSON.stringify({
          tag_name: tag,
          target_commitish: controls,
          name: tag,
          body,
          draft: true,
          prerelease: true,
        }),
      );
      id = json("api", "--method", "POST", api, "--input", request).id;
    }
  }
  let remote = read();
  if (command === "create" || command === "upload") {
    for (const asset of remote) {
      const entry = expected.find((item) => item.name === asset.name);
      if (!entry) {
        if (command === "create") throw new Error(`Unexpected transport asset: ${asset.name}`);
        continue;
      }
      if (asset.state !== "starter" || asset.size !== 0) verify(asset, entry);
    }
    for (const entry of expected) {
      remote = read();
      const asset = remote.find((item) => item.name === entry.name);
      if (asset?.state === "starter" && asset.size === 0) {
        gh("api", "--method", "DELETE", `${api}/assets/${asset.id}`);
        read();
      } else if (asset) {
        verify(asset, entry);
        continue;
      }
      gh(
        "api",
        "--method",
        "POST",
        `https://uploads.github.com/${api}/${id}/assets?name=${encodeURIComponent(entry.name)}`,
        "--header",
        "Content-Type: application/octet-stream",
        "--input",
        NodePath.join(root, entry.name),
      );
    }
    remote = read();
    for (const entry of expected) {
      const asset = remote.find((item) => item.name === entry.name);
      if (!asset) throw new Error(`Missing transport asset: ${entry.name}`);
      verify(asset, entry);
    }
    output(outputKey, JSON.stringify(expected));
    if (command === "create") {
      output("staging_id", id);
      output("build_attempt", attempt);
    }
  } else if (command === "download" || command === "collect") {
    if (
      command === "collect" &&
      (remote.length !== expected.length ||
        remote.some((asset) => !expected.some((entry) => entry.name === asset.name)))
    )
      throw new Error("Unexpected or missing transport assets");
    for (const entry of expected) {
      const asset = remote.find((item) => item.name === entry.name);
      if (!asset) throw new Error(`Missing transport asset: ${entry.name}`);
      if (
        asset.state !== "uploaded" ||
        asset.size !== entry.size ||
        (asset.digest && asset.digest !== entry.digest)
      )
        throw new Error(`Changed transport asset: ${entry.name}`);
    }
    NodeFS.mkdirSync(root, { recursive: true });
    if (NodeFS.readdirSync(root).length) throw new Error("Transport destination must be empty");
    for (const entry of expected)
      verify(
        remote.find((asset) => asset.name === entry.name),
        entry,
        NodePath.join(root, entry.name),
      );
  } else {
    const finalId = json(
      "release",
      "view",
      finalTag,
      "--repo",
      repository,
      "--json",
      "databaseId",
    ).databaseId;
    if (!Number.isSafeInteger(finalId) || finalId < 1 || finalId === id)
      throw new Error("Invalid final release ID");
    const final = json("api", `${api}/${finalId}`);
    if (
      final.draft !== false ||
      final.tag_name !== finalTag ||
      final.target_commitish !== controls ||
      final.body !== NodeFS.readFileSync(NodePath.join(root, "release-notes.md"), "utf8") ||
      !Array.isArray(final.assets) ||
      final.assets.length !== expected.length ||
      new Set(final.assets.map((asset) => asset.name)).size !== expected.length
    )
      throw new Error("Final publication not verified; retaining staging draft");
    for (const entry of expected) {
      const asset = final.assets.find((item) => item.name === entry.name);
      if (!asset) throw new Error("Final publication incomplete; retaining staging draft");
      verify(asset, entry);
    }
    read();
    gh("api", "--method", "DELETE", `${api}/${id}`);
  }
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
