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
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

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
vi.mock("./ProjectAccentEditor", () => ({ ProjectAccentEditor: () => null }));

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
function mount(members = [local]) {
  act(() => {
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
  it("creates a missing file only for typed not_found and compares against absence", async () => {
    mount();
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
    mount();
    mocks.read.mockResolvedValue(result);
    await expect(save()).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("preserves existing content, uses CAS, refreshes the sidebar and routes each checkout to its environment", async () => {
    mount([local, remote]);
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
    mount([local, remote]);
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
    mount();
    mocks.update.mockResolvedValue(failure(new Error("Offline")));
    await expect(save()).rejects.toThrow("Accent saved, but sidebar refresh failed");
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("does not create a file when resetting a missing accent", async () => {
    mount();
    mocks.read.mockResolvedValue(missing());
    await save(null);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: local.environmentId,
      input: { projectId: local.id },
    });
  });
});
