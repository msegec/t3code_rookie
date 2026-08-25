import { isProjectUploadTargetExistsError, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { create } from "zustand";

import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
import { readPreparedConnection } from "../state/session";
import { randomUUID } from "./utils";
import { uploadXhr } from "./uploadXhr";

const MAX_UPLOADS_PER_ENVIRONMENT = 3;
// Matches the upload token TTL (see PROJECT_UPLOAD_URL_TTL_MS), since
// workspace uploads allow files up to 100 MiB.
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type WorkspaceUploadState =
  | {
      readonly status: "uploading";
      readonly name: string;
      readonly relativePath: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly progress: number;
    }
  | {
      readonly status: "failed";
      readonly name: string;
      readonly relativePath: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly reason: string;
    };

interface WorkspaceUploadStore {
  readonly uploadsById: Readonly<Record<string, WorkspaceUploadState>>;
}

export const useWorkspaceUploadStore = create<WorkspaceUploadStore>(() => ({
  uploadsById: {},
}));

interface UploadJob {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly file: File;
  readonly onUploaded: (relativePath: string) => void;
  readonly onOverwriteStart: ((relativePath: string) => void) | undefined;
  readonly onSettled: ((relativePath: string) => void) | undefined;
  overwrite: boolean;
  cancelled: boolean;
  abort: (() => void) | null;
}

// Jobs stay here from queueing through a terminal state (failed) so retry can
// reuse the original File. Success and cancellation remove the entry.
const jobsById = new Map<string, UploadJob>();
const queue: UploadJob[] = [];
const activeUploadsByEnvironment = new Map<EnvironmentId, number>();

function setUploadState(uploadId: string, upload: WorkspaceUploadState): void {
  useWorkspaceUploadStore.setState((state) => ({
    uploadsById: { ...state.uploadsById, [uploadId]: upload },
  }));
}

function clearUploadState(uploadId: string): void {
  useWorkspaceUploadStore.setState((state) => {
    if (!(uploadId in state.uploadsById)) {
      return state;
    }
    const uploadsById = { ...state.uploadsById };
    delete uploadsById[uploadId];
    return { uploadsById };
  });
}

function failJob(job: UploadJob, reason: string): void {
  setUploadState(job.id, {
    status: "failed",
    name: job.file.name,
    relativePath: job.relativePath,
    environmentId: job.environmentId,
    cwd: job.cwd,
    reason,
  });
}

function mintUploadUrl(job: UploadJob) {
  return runAtomCommand(
    appAtomRegistry,
    projectEnvironment.createUploadUrl,
    {
      environmentId: job.environmentId,
      input: {
        cwd: job.cwd,
        relativePath: job.relativePath,
        sizeBytes: job.file.size,
        ...(job.overwrite ? { overwrite: true } : {}),
      },
    },
    { reportFailure: false },
  );
}

async function runUpload(job: UploadJob): Promise<void> {
  let minted = await mintUploadUrl(job);
  if (job.cancelled) {
    jobsById.delete(job.id);
    return;
  }

  if (minted._tag !== "Success") {
    if (!isProjectUploadTargetExistsError(Cause.squash(minted.cause))) {
      failJob(job, "Upload could not start");
      return;
    }

    const confirmed = await readLocalApi()?.dialogs.confirm(
      `Replace ${job.relativePath}?\nA file named '${job.relativePath}' already exists in this project.`,
      { variant: "destructive" },
    );
    if (job.cancelled) {
      jobsById.delete(job.id);
      return;
    }
    if (confirmed !== true) {
      failJob(job, "File already exists");
      return;
    }

    job.overwrite = true;
    // The upload replaces the target's bytes outside the serial save lane, so
    // pending saves of the file hold from here until the job settles.
    job.onOverwriteStart?.(job.relativePath);
    minted = await mintUploadUrl(job);
    if (job.cancelled) {
      jobsById.delete(job.id);
      return;
    }
    if (minted._tag !== "Success") {
      failJob(job, "Upload could not start");
      return;
    }
  }

  const connection = readPreparedConnection(job.environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl) : null;
  if (!url) {
    failJob(job, "Not connected");
    return;
  }

  let lastStep = -1;
  const upload = uploadXhr({
    url,
    file: job.file,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    onProgress: (progress) => {
      const step = Math.floor(progress * 20);
      if (step === lastStep || job.cancelled) {
        return;
      }
      lastStep = step;
      setUploadState(job.id, {
        status: "uploading",
        name: job.file.name,
        relativePath: job.relativePath,
        environmentId: job.environmentId,
        cwd: job.cwd,
        progress,
      });
    },
  });
  job.abort = upload.abort;

  try {
    await upload.done;
    if (job.cancelled) {
      jobsById.delete(job.id);
      return;
    }
    jobsById.delete(job.id);
    clearUploadState(job.id);
    try {
      job.onUploaded(job.relativePath);
    } catch (error) {
      // The upload itself succeeded; a throwing refresh callback must not
      // resurrect the cleared entry as an unretryable failure.
      console.error(error);
    }
  } catch (error) {
    if (job.cancelled) {
      jobsById.delete(job.id);
      return;
    }
    failJob(job, error instanceof Error ? error.message : "Upload failed");
  } finally {
    job.abort = null;
  }
}

function pumpUploads(): void {
  for (let index = 0; index < queue.length; ) {
    const job = queue[index]!;
    const active = activeUploadsByEnvironment.get(job.environmentId) ?? 0;
    if (active >= MAX_UPLOADS_PER_ENVIRONMENT) {
      index += 1;
      continue;
    }

    queue.splice(index, 1);
    if (job.cancelled) {
      continue;
    }
    activeUploadsByEnvironment.set(job.environmentId, active + 1);
    void runUpload(job)
      .catch(() => {
        if (!job.cancelled) {
          failJob(job, "Upload failed");
        }
      })
      .finally(() => {
        try {
          job.onSettled?.(job.relativePath);
        } catch (error) {
          // A throwing settle callback must not stall the queue.
          console.error(error);
        }
        const remaining = (activeUploadsByEnvironment.get(job.environmentId) ?? 1) - 1;
        if (remaining > 0) {
          activeUploadsByEnvironment.set(job.environmentId, remaining);
        } else {
          activeUploadsByEnvironment.delete(job.environmentId);
        }
        pumpUploads();
      });
  }
}

export function startWorkspaceUploads(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly files: ReadonlyArray<File>;
  readonly onUploaded: (relativePath: string) => void;
  /** An overwrite of the path was confirmed and is about to run. */
  readonly onOverwriteStart?: (relativePath: string) => void;
  /** The job reached a terminal state: stored, failed, or cancelled. */
  readonly onSettled?: (relativePath: string) => void;
}): void {
  for (const file of input.files) {
    const id = randomUUID();
    // Uploads land at the project root in v1. The RPC schema trims the path
    // on encode, so an untrimmed name would store the file under a different
    // path than the one the job reports.
    const relativePath = file.name.trim();
    const job: UploadJob = {
      id,
      environmentId: input.environmentId,
      cwd: input.cwd,
      relativePath,
      file,
      onUploaded: input.onUploaded,
      onOverwriteStart: input.onOverwriteStart,
      onSettled: input.onSettled,
      overwrite: false,
      cancelled: false,
      abort: null,
    };
    jobsById.set(id, job);
    if (relativePath === "") {
      failJob(job, "File name is empty");
      continue;
    }
    queue.push(job);
    setUploadState(id, {
      status: "uploading",
      name: file.name,
      relativePath,
      environmentId: input.environmentId,
      cwd: input.cwd,
      progress: 0,
    });
  }
  pumpUploads();
}

export function cancelWorkspaceUpload(uploadId: string): void {
  const job = jobsById.get(uploadId);
  if (!job) {
    return;
  }
  job.cancelled = true;
  jobsById.delete(uploadId);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
  }
  job.abort?.();
  clearUploadState(uploadId);
}

export function retryWorkspaceUpload(uploadId: string): void {
  const job = jobsById.get(uploadId);
  if (!job) {
    return;
  }
  // A second click can land before the row rerenders; only failed jobs restart.
  if (useWorkspaceUploadStore.getState().uploadsById[uploadId]?.status !== "failed") {
    return;
  }
  job.cancelled = false;
  // The target may have changed since the original confirmation, so a retry
  // re-confirms an overwrite instead of carrying the earlier answer over.
  job.overwrite = false;
  setUploadState(job.id, {
    status: "uploading",
    name: job.file.name,
    relativePath: job.relativePath,
    environmentId: job.environmentId,
    cwd: job.cwd,
    progress: 0,
  });
  queue.push(job);
  pumpUploads();
}

export function dismissWorkspaceUpload(uploadId: string): void {
  jobsById.delete(uploadId);
  clearUploadState(uploadId);
}
