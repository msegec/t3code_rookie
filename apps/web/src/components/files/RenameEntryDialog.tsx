import { isProjectRenameEntryTargetExistsError, type EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

export function RenameEntryDialog({
  environmentId,
  cwd,
  relativePath,
  onClose,
  onRenameStart,
  onRenamed,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly onClose: () => void;
  /** The rename is about to run; pending saves for the path must not enqueue behind it. */
  readonly onRenameStart?: () => void;
  readonly onRenamed: (newRelativePath: string) => void;
}) {
  const lastSlash = relativePath.lastIndexOf("/");
  const directoryPrefix = lastSlash === -1 ? "" : relativePath.slice(0, lastSlash + 1);
  const basename = lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
  const [name, setName] = useState(basename);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRenamingRef = useRef(false);
  const formId = useId();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // Select the name without its extension so typing replaces just the stem.
      const dotIndex = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dotIndex > 0 ? dotIndex : input.value.length);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  // Renaming onto the unchanged name fails server-side with targetExists, so
  // submit stays disabled until the name actually changes.
  const candidate = name.trim();
  const submitDisabled =
    isRenaming || candidate.length === 0 || candidate === basename || candidate.includes("/");

  const submitRename = async () => {
    if (isRenamingRef.current || submitDisabled) {
      return;
    }
    isRenamingRef.current = true;
    setIsRenaming(true);
    setRenameError(null);
    const newRelativePath = `${directoryPrefix}${candidate}`;
    onRenameStart?.();
    const result = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.renameEntry,
      {
        environmentId,
        input: { cwd, relativePath, newRelativePath },
      },
      { reportFailure: false },
    );
    isRenamingRef.current = false;
    setIsRenaming(false);
    if (result._tag === "Success") {
      onRenamed(newRelativePath);
      onClose();
      return;
    }
    setRenameError(
      isProjectRenameEntryTargetExistsError(Cause.squash(result.cause))
        ? "A file with that name already exists."
        : "Rename failed. Try again.",
    );
  };

  const cancelRename = () => {
    if (isRenamingRef.current) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelRename();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Rename <code>{relativePath}</code>. The file stays in its folder.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <Input
              ref={inputRef}
              aria-label="New file name"
              autoComplete="off"
              disabled={isRenaming}
              name="rename-entry-name"
              spellCheck={false}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {renameError ? <p className="text-sm text-destructive">{renameError}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isRenaming} type="button" variant="outline" onClick={cancelRename}>
            Cancel
          </Button>
          <Button disabled={submitDisabled} form={formId} type="submit">
            Rename
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
