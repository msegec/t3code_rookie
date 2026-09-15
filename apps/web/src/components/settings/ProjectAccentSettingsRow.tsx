import { ProjectReadFileError, T3_PROJECT_FILE_NAME, type ProjectAccent } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useCallback, useEffect, useState } from "react";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { ProjectAccentEditor } from "./ProjectAccentEditor";
import { editProjectAccent } from "./projectAccentSettings";
import { SettingsRow } from "./settingsLayout";

const isProjectReadFileError = Schema.is(ProjectReadFileError);

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
  const { environmentId, workspaceRoot } = representative;
  const [readAttempt, retryRead] = useState(0);
  const targetKey = JSON.stringify([environmentId, workspaceRoot, readAttempt]);
  const [loaded, setLoaded] = useState<{
    key: string;
    current: ProjectAccent | null;
    error: string | null;
  } | null>(null);
  const readContents = useCallback(
    async (member: Pick<SidebarProjectGroupMember, "environmentId" | "workspaceRoot">) => {
      const read = await readFile({
        environmentId: member.environmentId,
        input: { cwd: member.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME },
      });
      if (read._tag === "Failure") {
        const error = squashAtomCommandFailure(read);
        if (isProjectReadFileError(error) && error.failure === "not_found") return null;
        throw error;
      }
      if (read.value.truncated) throw new Error("t3.json is too large to edit safely.");
      return read.value.contents;
    },
    [readFile],
  );
  useEffect(() => {
    let active = true;
    void readContents({ environmentId, workspaceRoot })
      .then((contents) => {
        const projectFile = contents === null ? null : parseT3ProjectFile(contents);
        if (contents !== null && projectFile === null) {
          throw new Error("Fix the invalid t3.json before changing its sidebar accent.");
        }
        if (active)
          setLoaded({ key: targetKey, current: projectFile?.accentColor ?? null, error: null });
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({
            key: targetKey,
            current: null,
            error: error instanceof Error ? error.message : "Could not read t3.json.",
          });
      });
    return () => {
      active = false;
    };
  }, [environmentId, workspaceRoot, readContents, targetKey]);
  const save = useCallback(
    async (accent: ProjectAccent | null) => {
      for (const member of members) {
        try {
          const input = { cwd: member.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME };
          const contents = await readContents(member);
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
      setLoaded((previous) =>
        previous?.key === targetKey ? { ...previous, current: accent } : previous,
      );
    },
    [members, readContents, writeFile, updateProject, targetKey],
  );
  return (
    <SettingsRow
      title="Sidebar accent"
      description={
        members.length > 1
          ? "Saved in each selected checkout's t3.json. Applies to the web and desktop sidebar."
          : "Saved in this checkout's t3.json. Applies to the web and desktop sidebar."
      }
      control={
        loaded?.key !== targetKey ? (
          <p role="status">Loading sidebar accent...</p>
        ) : loaded.error ? (
          <div className="grid gap-2">
            <p role="alert">{loaded.error}</p>
            <Button size="sm" variant="outline" onClick={() => retryRead((attempt) => attempt + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <ProjectAccentEditor key={targetKey} current={loaded.current} onSave={save} />
        )
      }
    />
  );
}
