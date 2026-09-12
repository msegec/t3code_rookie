import { ProjectReadFileError, T3_PROJECT_FILE_NAME, type ProjectAccent } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "../files/projectFilesQueryState";
import { ProjectAccentEditor } from "./ProjectAccentEditor";
import { editProjectAccent } from "./projectAccentSettings";
import { SettingsRow } from "./settingsLayout";

export function ProjectAccentSettingsRow({
  members,
  representative,
}: {
  members: readonly SidebarProjectGroupMember[];
  representative: SidebarProjectGroupMember;
}) {
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const save = useCallback(
    async (accent: ProjectAccent | null) => {
      for (const member of members) {
        try {
          const input = { cwd: member.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME };
          const read = await readFile({ environmentId: member.environmentId, input });
          let contents: string | null = null;
          if (read._tag === "Failure") {
            const error = squashAtomCommandFailure(read);
            if (!(error instanceof ProjectReadFileError && error.failure === "not_found"))
              throw error;
          } else {
            if (read.value.truncated) throw new Error("t3.json is too large to edit safely.");
            contents = read.value.contents;
          }
          if (contents !== null || accent !== null) {
            const updated = editProjectAccent(contents, accent);
            const written = await writeFile({
              environmentId: member.environmentId,
              input: { ...input, contents: updated, expectedContents: contents },
            });
            if (written._tag === "Failure") throw squashAtomCommandFailure(written);
            setProjectFileQueryData(
              member.environmentId,
              member.workspaceRoot,
              T3_PROJECT_FILE_NAME,
              updated,
            );
            confirmProjectFileQueryData(
              member.environmentId,
              member.workspaceRoot,
              T3_PROJECT_FILE_NAME,
              updated,
            );
          }
          const refreshed = await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id },
          });
          if (refreshed._tag === "Failure") {
            throw new Error("Accent saved, but sidebar refresh failed. Save again to retry.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not save sidebar accent.";
          throw new Error(
            `${member.environmentLabel ?? "This environment"} (${member.workspaceRoot}): ${message}${members.length > 1 ? " Earlier checkouts may already be saved." : ""}`,
            { cause: error },
          );
        }
      }
    },
    [members, readFile, writeFile, updateProject],
  );
  return (
    <SettingsRow
      title="Sidebar accent"
      description={
        members.length > 1
          ? "Saved in each selected checkout's t3.json. Applies to the web and desktop sidebar."
          : "Saved in this checkout's t3.json. Applies to the web and desktop sidebar."
      }
      control={<ProjectAccentEditor current={representative.accent ?? null} onSave={save} />}
    />
  );
}
