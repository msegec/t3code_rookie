const FLEET_RELEASE_BASE_URL = "https://github.com/msegec/t3code_rookie/releases/download";
const FLEET_VERSION_PATTERN = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.mzs\.r[0-9a-f]{12}$/u;

export const isFleetVersion = (version: string): boolean =>
  FLEET_VERSION_PATTERN.test(version.trim());

export const fleetReleaseTarballUrl = (version: string): string =>
  `${FLEET_RELEASE_BASE_URL}/v${version}/t3-${version}.tgz`;
