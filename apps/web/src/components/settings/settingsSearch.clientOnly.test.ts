import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const desktop = vi.hoisted(() => ({ enabled: true }));
vi.mock("~/env", () => ({
  get isElectron() {
    return desktop.enabled;
  },
}));

import { filterAvailableSettingsSearchItems, searchSettings } from "./settingsSearch";

const availability = {
  hasCloudPublicConfig: false,
  hasEnvironment: false,
  hasProviderSettingsEnvironment: false,
  canManageLocalBackend: false,
  isWslSettingsRowVisible: false,
  hasThreadAutoSettlement: false,
};

afterEach(() => {
  desktop.enabled = true;
});

describe("local environment settings search", () => {
  it.each([
    { name: "empty catalog", hasEnvironment: false, canManageLocalBackend: false },
    { name: "remote-only catalog", hasEnvironment: true, canManageLocalBackend: false },
    { name: "primary catalog", hasEnvironment: true, canManageLocalBackend: true },
  ])("finds the desktop switch with an $name", (catalog) => {
    const items = filterAvailableSettingsSearchItems({ ...availability, ...catalog });
    expect(searchSettings("local environment", items)).toContainEqual(
      expect.objectContaining({
        id: "local-environment",
        to: "/settings/connections",
        desktopOnly: true,
      }),
    );
  });

  it("excludes the desktop switch in a web client", () => {
    desktop.enabled = false;
    expect(
      searchSettings("local environment", filterAvailableSettingsSearchItems(availability)).map(
        (item) => item.id,
      ),
    ).not.toContain("local-environment");
  });
});
