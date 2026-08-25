import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { RotateCcw, RotateCw, Upload, XIcon } from "lucide-react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { formatAttachmentUploadProgress } from "~/lib/attachmentUploadState";
import {
  cancelWorkspaceUpload,
  dismissWorkspaceUpload,
  retryWorkspaceUpload,
  startWorkspaceUploads,
  useWorkspaceUploadStore,
  type WorkspaceUploadState,
} from "~/lib/workspaceUploadQueue";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { WorkspaceFileDropOverlay } from "../chat/WorkspaceFileDropOverlay";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function UploadFilesButton(props: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Upload files"
            onClick={props.onClick}
          />
        }
      >
        <Upload />
      </TooltipTrigger>
      <TooltipPopup>Upload files</TooltipPopup>
    </Tooltip>
  );
}

function UploadRowButton(props: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-micro"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.icon}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function UploadRow(props: { id: string; upload: WorkspaceUploadState }) {
  const { id, upload } = props;
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 flex-1 truncate text-foreground">{upload.name}</span>}
        />
        <TooltipPopup>{upload.name}</TooltipPopup>
      </Tooltip>
      {upload.status === "uploading" ? (
        <>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatAttachmentUploadProgress(upload.progress)}
          </span>
          <UploadRowButton
            label={`Cancel upload of ${upload.name}`}
            icon={<XIcon />}
            onClick={() => cancelWorkspaceUpload(id)}
          />
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 max-w-32 shrink truncate text-destructive">
                  {upload.reason}
                </span>
              }
            />
            <TooltipPopup>{upload.reason}</TooltipPopup>
          </Tooltip>
          <UploadRowButton
            label={`Retry upload of ${upload.name}`}
            icon={<RotateCcw />}
            onClick={() => retryWorkspaceUpload(id)}
          />
          <UploadRowButton
            label={`Dismiss upload of ${upload.name}`}
            icon={<XIcon />}
            onClick={() => dismissWorkspaceUpload(id)}
          />
        </>
      )}
    </div>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      startWorkspaceUploads({
        environmentId,
        cwd,
        files,
        onUploaded: () => entriesQuery.refresh(),
      });
    },
    [cwd, entriesQuery, environmentId],
  );
  // The shared drop handlers manage drag-active state, but their onDrop reads
  // event.dataTransfer.files directly, which includes an unreadable stand-in
  // File for a dropped directory. Filter with dataTransfer.items instead so
  // directories never reach the upload queue.
  const fileDropHandlers = useMemo(
    () => makeWorkspaceFileDropHandlers({ setDragActive, addFiles: handleAddFiles }),
    [handleAddFiles],
  );
  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragActive(false);
      const items = Array.from(event.dataTransfer.items);
      const supportsEntries = items.length > 0 && typeof items[0]?.webkitGetAsEntry === "function";
      const files = supportsEntries
        ? items.flatMap((item) => {
            if (item.kind !== "file") return [];
            const entry = item.webkitGetAsEntry();
            if (entry !== null && !entry.isFile) return [];
            const file = item.getAsFile();
            return file ? [file] : [];
          })
        : Array.from(event.dataTransfer.files);
      handleAddFiles(files);
    },
    [handleAddFiles],
  );
  // Flattened [id, state, id, state, ...] so the shallow compare sees stable
  // string ids and per-upload state refs; uploads for other panels never
  // re-render this one.
  const uploadEntries = useWorkspaceUploadStore(
    useShallow((state) =>
      Object.entries(state.uploadsById)
        .filter(([, upload]) => upload.environmentId === environmentId && upload.cwd === cwd)
        .flat(),
    ),
  );
  const uploads = useMemo(() => {
    const pairs: Array<[string, WorkspaceUploadState]> = [];
    for (let index = 0; index < uploadEntries.length; index += 2) {
      pairs.push([
        uploadEntries[index] as string,
        uploadEntries[index + 1] as WorkspaceUploadState,
      ]);
    }
    return pairs;
  }, [uploadEntries]);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    entriesQuery.refresh();
    onRefreshSelectedFile?.();
  };

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    if (entryKinds.get(selectedPath) !== "file") return;
    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    selectedItem.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId, treePaths]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  return (
    <div
      ref={panelRef}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      onDragEnter={fileDropHandlers.onDragEnter}
      onDragOver={fileDropHandlers.onDragOver}
      onDragLeave={fileDropHandlers.onDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <WorkspaceFileDropOverlay
          icon={<Upload className="size-4 text-primary" aria-hidden="true" />}
          label="Drop files to upload"
          data-file-browser-drop-overlay="true"
        />
      ) : null}
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={entriesQuery.isPending} onRefresh={handleRefresh} />
        <UploadFilesButton onClick={() => fileInputRef.current?.click()} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            handleAddFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--contrast-foreground)",
          }}
        />
      )}
      {uploads.length > 0 ? (
        <div
          className="flex max-h-40 shrink-0 flex-col divide-y divide-border/60 overflow-y-auto border-t border-border/60"
          data-file-browser-uploads
        >
          {uploads.map(([id, upload]) => (
            <UploadRow key={id} id={id} upload={upload} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
