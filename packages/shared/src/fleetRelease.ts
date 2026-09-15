export const FLEET_RELEASE_REPOSITORY = "msegec/t3code_rookie";
export const FLEET_RELEASE_BASE_URL = `https://github.com/${FLEET_RELEASE_REPOSITORY}/releases/download`;
const FLEET_VERSION_PATTERN = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.mzs\.r[0-9a-f]{12}$/u;

export const isFleetVersion = (version: string): boolean =>
  FLEET_VERSION_PATTERN.test(version.trim());
