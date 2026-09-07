import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export function generateReleaseNotes(manifest, config, run = NodeChildProcess.execFileSync) {
  const overlays = manifest.overlays.map((overlay) => {
    if (!["applied", "included"].includes(overlay.action)) {
      throw new Error(`Invalid composition action: ${overlay.action}`);
    }
    if (overlay.kind) return overlay;
    const configured = config.overlays.find((entry) =>
      entry.kind === "commit"
        ? entry.sha === overlay.sha
        : overlay.overlay === `pull-request-${entry.number}`,
    );
    if (!configured)
      throw new Error(`Missing configuration for composed overlay ${overlay.overlay}`);
    return { ...configured, ...overlay };
  });
  const upstream = "pingdotgg/t3code";
  const api = (endpoint) =>
    JSON.parse(
      run("gh", ["api", `repos/${upstream}/${endpoint}`], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      }),
    );
  const release = api(`releases/tags/${encodeURIComponent(manifest.base.tag)}`);
  if (
    release.tag_name !== manifest.base.tag ||
    (release.body !== null && typeof release.body !== "string")
  ) {
    throw new Error("Invalid upstream release tag or notes");
  }
  const notes = [
    `## Official T3 Code ${manifest.base.tag}`,
    `Base release: [${manifest.base.tag}](https://github.com/${upstream}/releases/tag/${manifest.base.tag})`,
    release.body?.trim()
      ? release.body
      : "Upstream did not publish release notes for this release.",
    "## Our pull requests",
  ];
  const numbers = [
    ...new Set([
      ...(config.trackedPullRequests ?? []),
      ...overlays
        .filter((overlay) => overlay.kind === "pull-request")
        .map((overlay) => overlay.number),
    ]),
  ];
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Invalid tracked pull request number");
    const pull = api(`pulls/${number}`);
    if (
      pull.number !== number ||
      typeof pull.title !== "string" ||
      !["open", "closed"].includes(pull.state)
    ) {
      throw new Error(`Invalid upstream pull request #${number}`);
    }
    const candidate = pull.merged_at ? pull.merge_commit_sha : pull.head?.sha;
    if (typeof candidate !== "string" || !candidate)
      throw new Error(`Missing commit for pull request #${number}`);
    const comparison = api(`compare/${manifest.base.sha}...${candidate}?per_page=1`);
    if (!["ahead", "behind", "identical", "diverged"].includes(comparison.status)) {
      throw new Error(`Invalid ancestry for pull request #${number}`);
    }
    const included = comparison.status === "behind" || comparison.status === "identical";
    const status = pull.merged_at
      ? "Merged upstream"
      : pull.state === "open"
        ? "Open upstream"
        : "Closed without merge";
    notes.push(
      `- PR [#${number}: ${pull.title.replace(/[\r\n]+/g, " ")}](https://github.com/${upstream}/pull/${number}): ${status}; ${included ? "included" : "not included"} in this base.`,
    );
  }
  if (!numbers.length) notes.push("No upstream pull requests are tracked for this build.");
  notes.push("## Our changes stacked on this release");
  const applied = overlays.filter((overlay) => overlay.action === "applied");
  for (const overlay of applied) {
    if (overlay.kind === "pull-request") {
      notes.push(
        `- Stacked: [PR #${overlay.number}](https://github.com/${upstream}/pull/${overlay.number}) at ${overlay.sha}.`,
      );
      continue;
    }
    const configured = config.overlays.find(
      (entry) =>
        entry.kind === "commit" && entry.sha === overlay.sha && entry.name === overlay.name,
    );
    if (!configured?.repository) throw new Error(`Missing repository for overlay ${overlay.name}`);
    notes.push(
      `- Stacked: [${overlay.name}](https://github.com/${configured.repository}/commit/${overlay.sha}).`,
    );
  }
  if (!applied.length) notes.push("No additional overlays are stacked on this release.");
  return `${notes.join("\n\n")}\n`;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [manifestPath, configPath, output] = process.argv.slice(2);
  if (!manifestPath || !configPath || !output) {
    throw new Error(
      "Usage: node generate-release-notes.mjs <mzs-fleet.json> <overlays.json> <output.md>",
    );
  }
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
  NodeFS.writeFileSync(output, generateReleaseNotes(manifest, config));
}
