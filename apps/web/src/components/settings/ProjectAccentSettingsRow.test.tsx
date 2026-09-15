import {
  EnvironmentId,
  ProjectId,
  ProjectReadFileError,
  type ProjectAccent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { projectSettingsSearch } from "../../projectSettingsNavigation";
import { projectSettingsRepresentative } from "./ProjectSettingsPanel.logic";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  update: vi.fn(),
  setCache: vi.fn(),
  confirmCache: vi.fn(),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: "read", writeFile: "write", update: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "write" ? mocks.write : mocks.update),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.read }));
vi.mock("../files/projectFilesQueryState", () => ({
  setProjectFileQueryData: mocks.setCache,
  confirmProjectFileQueryData: mocks.confirmCache,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/toggle-group", () => ({ ToggleGroup: "toggle-group", Toggle: "toggle" }));

import { ProjectAccentEditor } from "./ProjectAccentEditor";
import { ProjectAccentSettingsRow } from "./ProjectAccentSettingsRow";

let renderer: ReactTestRenderer;
function member(name: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(name),
    environmentId: EnvironmentId.make(name),
    title: name,
    workspaceRoot: `/work/${name}`,
    physicalProjectKey: name,
    environmentLabel: name,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
const local = member("local");
const remote = member("remote");
async function mount(members = [local]) {
  await act(async () => {
    renderer = create(<ProjectAccentSettingsRow members={members} representative={local} />);
  });
}
async function save(accent: ProjectAccent | null = "#123456") {
  await act(async () => {
    await renderer.root.findByType(ProjectAccentEditor).props.onSave(accent);
  });
}
function failure(error: unknown) {
  return { _tag: "Failure", cause: Cause.fail(error) };
}
function missing() {
  return failure(
    new ProjectReadFileError({
      cwd: local.workspaceRoot,
      relativePath: "t3.json",
      failure: "not_found",
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ _tag: "Success", value: { contents: "{}\n", truncated: false } });
  mocks.write.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("ProjectAccentSettingsRow", () => {
  it.each([
    ["simple", "#F2A93B"],
    ["advanced", { idle: "#112233", active: "#445566", selected: "#778899" }],
  ])(
    "loads %s from checkout t3.json when the project snapshot has no accent",
    async (_mode, accent) => {
      mocks.read.mockResolvedValue({
        _tag: "Success",
        value: { contents: JSON.stringify({ accentColor: accent }), truncated: false },
      });
      await mount();
      expect(renderer.root.findByType(ProjectAccentEditor).props.current).toEqual(accent);
      expect(mocks.read).toHaveBeenCalledWith({
        environmentId: local.environmentId,
        input: { cwd: local.workspaceRoot, relativePath: "t3.json" },
      });
      expect(
        renderer.root.findByProps({ "aria-label": "Sidebar accent mode" }).props.value,
      ).toEqual([_mode]);
    },
  );

  it("creates a missing file by saving the displayed default and resets the saved state", async () => {
    mocks.read.mockResolvedValue(missing());
    await mount();
    const button = (label: string) =>
      renderer.root.findAllByType("button").find((item) => item.children.includes(label))!;
    expect(button("Save accent").props.disabled).toBe(false);
    await act(async () => button("Save accent").props.onClick());
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          expectedContents: null,
          contents: expect.stringContaining('"accentColor": "#1688f0"'),
        }),
      }),
    );
    expect(button("Save accent").props.disabled).toBe(true);
    await act(async () => button("Reset").props.onClick());
    expect(button("Reset").props.disabled).toBe(true);
  });

  it.each([
    [
      "permission",
      failure(
        new ProjectReadFileError({
          cwd: local.workspaceRoot,
          relativePath: "t3.json",
          failure: "operation_failed",
        }),
      ),
    ],
    ["disconnected", failure(new Error("Disconnected"))],
    ["malformed", { _tag: "Success", value: { contents: "{broken", truncated: false } }],
    ["truncated", { _tag: "Success", value: { contents: "{}", truncated: true } }],
  ])("shows an error instead of defaults for %s and retries", async (_name, result) => {
    mocks.read.mockResolvedValue(result);
    await mount();
    expect(renderer.root.findAllByType(ProjectAccentEditor)).toHaveLength(0);
    expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue({
      _tag: "Success",
      value: { contents: '{"accentColor":"#abcdef"}', truncated: false },
    });
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((item) => item.children.includes("Retry"))!
        .props.onClick(),
    );
    expect(renderer.root.findByProps({ "aria-label": "Accent hex colour" }).props.value).toBe(
      "#abcdef",
    );
  });

  it("drops unsaved edits when switching checkout and ignores a late read", async () => {
    await mount();
    act(() =>
      renderer.root
        .findByProps({ "aria-label": "Accent hex colour" })
        .props.onChange({ currentTarget: { value: "#112233" } }),
    );
    let finishRemote!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRemote = resolve;
        }),
    );
    await act(async () =>
      renderer.update(<ProjectAccentSettingsRow members={[remote]} representative={remote} />),
    );
    expect(renderer.root.findAllByType(ProjectAccentEditor)).toHaveLength(0);
    mocks.read.mockResolvedValue({
      _tag: "Success",
      value: { contents: '{"accentColor":"#abcdef"}', truncated: false },
    });
    await act(async () =>
      renderer.update(<ProjectAccentSettingsRow members={[local]} representative={local} />),
    );
    await act(async () =>
      finishRemote({
        _tag: "Success",
        value: { contents: '{"accentColor":"#998877"}', truncated: false },
      }),
    );
    expect(renderer.root.findByProps({ "aria-label": "Accent hex colour" }).props.value).toBe(
      "#abcdef",
    );
  });

  it("does not replace another checkout's accent when an earlier save completes", async () => {
    await mount();
    let finishWrite!: (value: unknown) => void;
    mocks.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = resolve;
        }),
    );
    let pendingSave!: Promise<void>;
    await act(async () => {
      pendingSave = renderer.root.findByType(ProjectAccentEditor).props.onSave("#112233");
    });
    mocks.read.mockResolvedValue({
      _tag: "Success",
      value: { contents: '{"accentColor":"#abcdef"}', truncated: false },
    });
    await act(async () =>
      renderer.update(<ProjectAccentSettingsRow members={[remote]} representative={remote} />),
    );
    await act(async () => {
      finishWrite({ _tag: "Success", value: undefined });
      await pendingSave;
    });
    expect(renderer.root.findByProps({ "aria-label": "Accent hex colour" }).props.value).toBe(
      "#abcdef",
    );
  });

  it("opens the selected checkout's gold appearance and saves only that checkout", async () => {
    const projects = [local, { ...remote, accent: "#F2A93B", faviconPath: "gold.png" }].map(
      (project) => ({
        ...project,
        repositoryIdentity: {
          canonicalKey: "github.com/example/repo",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://github.com/example/repo.git",
          },
          provider: "github",
          owner: "example",
          name: "repo",
          displayName: "repo",
        },
      }),
    );
    const group = buildSidebarProjectSnapshots({
      projects,
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: local.environmentId,
      resolveEnvironmentLabel: () => null,
    })[0]!;
    const search = projectSettingsSearch(group.projectKey, remote);
    const members = group.memberProjects.filter(
      (project) =>
        (!search.machine || project.environmentId === search.machine) &&
        (!search.checkout || project.physicalProjectKey === search.checkout),
    );
    const representative = projectSettingsRepresentative(group, members);
    mocks.read.mockResolvedValue({
      _tag: "Success",
      value: { contents: '{"accentColor":"#F2A93B"}\n', truncated: false },
    });
    await act(async () => {
      renderer = create(
        <ProjectAccentSettingsRow members={members} representative={representative} />,
      );
    });
    expect(representative.faviconPath).toBe("gold.png");
    expect(renderer.root.findByType(ProjectAccentEditor).props.current).toBe("#F2A93B");
    await save("#F2A93B");
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: remote.environmentId,
      input: {
        cwd: remote.workspaceRoot,
        relativePath: "t3.json",
        expectedContents: '{"accentColor":"#F2A93B"}\n',
        contents: '{"accentColor":"#F2A93B"}\n',
      },
    });
  });

  it("creates a missing file only for typed not_found and compares against absence", async () => {
    await mount();
    mocks.read.mockResolvedValue(missing());
    await save();
    expect(mocks.write).toHaveBeenCalledWith({
      environmentId: local.environmentId,
      input: {
        cwd: local.workspaceRoot,
        relativePath: "t3.json",
        contents: expect.stringContaining('"accentColor": "#123456"'),
        expectedContents: null,
      },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: local.environmentId,
      input: { projectId: local.id },
    });
  });

  it.each([
    ["untyped missing", failure(new Error("not_found"))],
    [
      "permission failure",
      failure(
        new ProjectReadFileError({
          cwd: "/work/local",
          relativePath: "t3.json",
          failure: "operation_failed",
        }),
      ),
    ],
    ["truncated file", { _tag: "Success", value: { contents: "{}", truncated: true } }],
    ["invalid file", { _tag: "Success", value: { contents: "{broken", truncated: false } }],
  ])("refuses writes after %s", async (_name, result) => {
    await mount();
    mocks.read.mockResolvedValue(result);
    await expect(save()).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("preserves existing content, uses CAS, refreshes the sidebar and routes each checkout to its environment", async () => {
    await mount([local, remote]);
    const source = '{\n // keep\n "unknown": true\n}\n';
    mocks.read.mockResolvedValue({
      _tag: "Success",
      value: { contents: source, truncated: false },
    });
    await save();
    for (const target of [local, remote]) {
      expect(mocks.read).toHaveBeenCalledWith({
        environmentId: target.environmentId,
        input: { cwd: target.workspaceRoot, relativePath: "t3.json" },
      });
      expect(mocks.write).toHaveBeenCalledWith({
        environmentId: target.environmentId,
        input: {
          cwd: target.workspaceRoot,
          relativePath: "t3.json",
          expectedContents: source,
          contents: expect.stringContaining("// keep"),
        },
      });
      expect(mocks.update).toHaveBeenCalledWith({
        environmentId: target.environmentId,
        input: { projectId: target.id },
      });
      expect(mocks.confirmCache).toHaveBeenCalledWith(
        target.environmentId,
        target.workspaceRoot,
        "t3.json",
        expect.stringContaining('"accentColor": "#123456"'),
      );
    }
  });

  it("reports the failed remote checkout after a partial save and does not refresh a rejected write", async () => {
    await mount([local, remote]);
    mocks.write
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce(failure(new Error("File changed.")));
    await expect(save()).rejects.toThrow(
      "remote (/work/remote): File changed. Earlier checkouts may already be saved.",
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.setCache).toHaveBeenCalledTimes(1);
  });

  it("reports a refresh failure after a successful file write", async () => {
    await mount();
    mocks.update.mockResolvedValue(failure(new Error("Offline")));
    await expect(save()).rejects.toThrow("Accent saved, but sidebar refresh failed");
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("does not create a file when resetting a missing accent", async () => {
    await mount();
    mocks.read.mockResolvedValue(missing());
    await save(null);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: local.environmentId,
      input: { projectId: local.id },
    });
  });
});
