import { compareSemverVersions } from "@t3tools/shared/semver";

const NIGHTLY_TAG_PATTERN = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export const FLEET_BUILD_LABEL = import.meta.env.VITE_MZS_FLEET_LABEL?.trim() || null;
export const FLEET_BASE_TAG = import.meta.env.VITE_MZS_FLEET_BASE_TAG?.trim() || null;

export type FleetSyncStatus =
  | { readonly status: "current" }
  | { readonly status: "available"; readonly latestTag: string }
  | { readonly status: "unavailable" };

export function resolveFleetSyncStatus(
  baseTag: string,
  releaseTags: ReadonlyArray<string>,
): FleetSyncStatus {
  if (!NIGHTLY_TAG_PATTERN.test(baseTag)) return { status: "unavailable" };

  const latestTag = releaseTags
    .filter((tag) => NIGHTLY_TAG_PATTERN.test(tag))
    .reduce<string | null>(
      (latest, tag) =>
        latest === null || compareSemverVersions(tag.slice(1), latest.slice(1)) > 0 ? tag : latest,
      null,
    );
  if (!latestTag) return { status: "unavailable" };

  return compareSemverVersions(latestTag.slice(1), baseTag.slice(1)) > 0
    ? { status: "available", latestTag }
    : { status: "current" };
}

export async function fetchFleetSyncStatus(
  baseTag: string,
  signal?: AbortSignal,
): Promise<FleetSyncStatus> {
  const response = await fetch(
    "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100",
    {
      headers: { Accept: "application/vnd.github+json" },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) return { status: "unavailable" };

  const releases: unknown = await response.json();
  if (!Array.isArray(releases)) return { status: "unavailable" };

  return resolveFleetSyncStatus(
    baseTag,
    releases.flatMap((release) =>
      typeof release === "object" &&
      release !== null &&
      "tag_name" in release &&
      typeof release.tag_name === "string"
        ? [release.tag_name]
        : [],
    ),
  );
}
