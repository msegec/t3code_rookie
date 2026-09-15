import type { EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  discardSavesRef?: { current: FileSaveControls | null } | undefined;
}

export interface FileSaveControls {
  suspend: () => void;
  resume: () => void;
  discard: () => void;
  reset: () => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  discardSavesRef,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: (nextContents) =>
            writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents },
            }),
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          },
        });
        coordinatorRef.current = coordinator;
        if (discardSavesRef) {
          discardSavesRef.current = {
            suspend: () => coordinator.suspend(),
            resume: () => coordinator.resume(),
            discard: () => coordinator.discard(),
            reset: () => coordinator.reset(),
          };
        }
        return () => {
          coordinatorRef.current = null;
          if (discardSavesRef) discardSavesRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, discardSavesRef, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
