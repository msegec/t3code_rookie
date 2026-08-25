import { EnvironmentId, ProjectUploadTargetExistsError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createUploadUrl: Symbol("create-upload-url"),
  runAtomCommand: vi.fn(),
  readPreparedConnection: vi.fn(),
  requestConfirmDialog: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

vi.mock("../state/projects", () => ({
  projectEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
  },
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: mocks.requestConfirmDialog } }),
}));

import {
  cancelWorkspaceUpload,
  dismissWorkspaceUpload,
  retryWorkspaceUpload,
  startWorkspaceUploads,
  useWorkspaceUploadStore,
} from "./workspaceUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const environmentId = EnvironmentId.make("environment-1");
const cwd = "/workspace/project";

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name);
}

function mintedResult(relativePath: string) {
  return {
    _tag: "Success" as const,
    value: {
      relativePath,
      relativeUrl: `/api/workspace/upload/token-${relativePath}`,
      expiresAt: 1,
    },
  };
}

function targetExistsFailure(relativePath: string) {
  return {
    _tag: "Failure" as const,
    cause: Cause.fail(new ProjectUploadTargetExistsError({ cwd, relativePath })),
  };
}

function genericMintFailure() {
  return {
    _tag: "Failure" as const,
    cause: Cause.fail({
      _tag: "ProjectCreateUploadUrlError",
      message: "boom",
    }),
  };
}

function uploadsById() {
  return useWorkspaceUploadStore.getState().uploadsById;
}

function findUpload(name: string) {
  return Object.entries(uploadsById()).find(([, upload]) => upload.name === name);
}

describe("workspaceUploadQueue", () => {
  beforeEach(() => {
    TestXmlHttpRequest.requests = [];
    mocks.runAtomCommand.mockReset();
    mocks.readPreparedConnection.mockReset();
    mocks.requestConfirmDialog.mockReset();
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://environment.test/" });
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: { readonly input: { readonly relativePath: string } },
      ) => {
        if (command === mocks.createUploadUrl) {
          return mintedResult(target.input.relativePath);
        }
        throw new Error("unexpected command");
      },
    );
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    useWorkspaceUploadStore.setState({ uploadsById: {} });
    vi.unstubAllGlobals();
  });

  it("uploads a file, reports progress, then removes the entry and calls onUploaded", async () => {
    const onUploaded = vi.fn();
    const file = makeFile("notes.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded });
    await Promise.resolve();
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://environment.test/api/workspace/upload/token-notes.txt");
    expect(request.headers.has("Content-Type")).toBe(false);

    request.progress(1, 2);
    const [uploadId, uploading] = findUpload("notes.txt")!;
    expect(uploading).toMatchObject({
      status: "uploading",
      relativePath: "notes.txt",
      environmentId,
      cwd,
      progress: 0.5,
    });

    request.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadsById()[uploadId]).toBeUndefined();
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed upload out of the failed state when onUploaded throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = makeFile("notes.txt");
    startWorkspaceUploads({
      environmentId,
      cwd,
      files: [file],
      onUploaded: () => {
        throw new Error("refresh failed");
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    TestXmlHttpRequest.requests[0]!.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(findUpload("notes.txt")).toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("marks the entry failed with a reason when minting fails", async () => {
    mocks.runAtomCommand.mockResolvedValue(genericMintFailure());
    const file = makeFile("broken.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [, failed] = findUpload("broken.txt")!;
    expect(failed).toMatchObject({ status: "failed", reason: "Upload could not start" });
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
  });

  it("re-mints with overwrite and uploads when the user confirms replacing an existing file", async () => {
    let call = 0;
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly input: { readonly relativePath: string; readonly overwrite?: boolean };
        },
      ) => {
        if (command !== mocks.createUploadUrl) throw new Error("unexpected command");
        call += 1;
        if (call === 1) {
          expect(target.input.overwrite).toBeUndefined();
          return targetExistsFailure(target.input.relativePath);
        }
        expect(target.input.overwrite).toBe(true);
        return mintedResult(target.input.relativePath);
      },
    );
    mocks.requestConfirmDialog.mockResolvedValue(true);

    const file = makeFile("existing.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.requestConfirmDialog).toHaveBeenCalledWith(
      "Replace existing.txt?\nA file named 'existing.txt' already exists in this project.",
      { variant: "destructive" },
    );
    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    TestXmlHttpRequest.requests[0]!.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(findUpload("existing.txt")).toBeUndefined();
  });

  it("prompts to replace and retries with overwrite when the commit loses the race with 409", async () => {
    const seenOverwrites: Array<boolean | undefined> = [];
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly input: { readonly relativePath: string; readonly overwrite?: boolean };
        },
      ) => {
        if (command !== mocks.createUploadUrl) throw new Error("unexpected command");
        seenOverwrites.push(target.input.overwrite);
        return mintedResult(target.input.relativePath);
      },
    );
    mocks.requestConfirmDialog.mockResolvedValue(true);

    const file = makeFile("raced.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    TestXmlHttpRequest.requests[0]!.complete(409);
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();

    expect(mocks.requestConfirmDialog).toHaveBeenCalledWith(
      "Replace raced.txt?\nA file named 'raced.txt' already exists in this project.",
      { variant: "destructive" },
    );
    expect(seenOverwrites).toEqual([undefined, true]);
    expect(TestXmlHttpRequest.requests).toHaveLength(2);
    expect(findUpload("raced.txt")![1]).toMatchObject({ status: "uploading" });

    TestXmlHttpRequest.requests[1]!.complete();
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

    expect(findUpload("raced.txt")).toBeUndefined();
  });

  it("marks the entry failed when the user declines to replace after a commit-time 409", async () => {
    mocks.requestConfirmDialog.mockResolvedValue(false);

    const file = makeFile("raced.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    TestXmlHttpRequest.requests[0]!.complete(409);
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();

    expect(mocks.requestConfirmDialog).toHaveBeenCalledTimes(1);
    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    expect(findUpload("raced.txt")![1]).toMatchObject({
      status: "failed",
      reason: "File already exists",
    });
  });

  it("marks the entry failed with 'File already exists' when the user declines to replace", async () => {
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: { readonly input: { readonly relativePath: string } },
      ) => {
        if (command !== mocks.createUploadUrl) throw new Error("unexpected command");
        return targetExistsFailure(target.input.relativePath);
      },
    );
    mocks.requestConfirmDialog.mockResolvedValue(false);

    const file = makeFile("existing.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [, failed] = findUpload("existing.txt")!;
    expect(failed).toMatchObject({ status: "failed", reason: "File already exists" });
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
  });

  it("cancelWorkspaceUpload aborts the in-flight XHR and removes the entry", async () => {
    const file = makeFile("cancel-me.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    const [uploadId] = findUpload("cancel-me.txt")!;
    cancelWorkspaceUpload(uploadId);

    expect(uploadsById()[uploadId]).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(request.listeners.has("abort")).toBe(true);
  });

  it("caps concurrent uploads at 3 per environment", async () => {
    const files = ["a.txt", "b.txt", "c.txt", "d.txt"].map(makeFile);
    startWorkspaceUploads({ environmentId, cwd, files, onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(3);

    for (const request of TestXmlHttpRequest.requests) {
      request.complete();
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(4);
  });

  it("retryWorkspaceUpload restarts a failed entry", async () => {
    mocks.runAtomCommand.mockResolvedValueOnce(genericMintFailure());
    const file = makeFile("retry.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [uploadId, failed] = findUpload("retry.txt")!;
    expect(failed).toMatchObject({ status: "failed" });

    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: { readonly input: { readonly relativePath: string } },
      ) => {
        if (command !== mocks.createUploadUrl) throw new Error("unexpected command");
        return mintedResult(target.input.relativePath);
      },
    );
    retryWorkspaceUpload(uploadId);
    await Promise.resolve();
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    expect(uploadsById()[uploadId]).toMatchObject({ status: "uploading" });

    TestXmlHttpRequest.requests[0]!.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadsById()[uploadId]).toBeUndefined();
  });

  it("retryWorkspaceUpload ignores a second click while the retry is already uploading", async () => {
    mocks.runAtomCommand.mockResolvedValueOnce(genericMintFailure());
    const file = makeFile("retry-twice.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [uploadId] = findUpload("retry-twice.txt")!;
    retryWorkspaceUpload(uploadId);
    retryWorkspaceUpload(uploadId);
    await Promise.resolve();
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(1);
    expect(uploadsById()[uploadId]).toMatchObject({ status: "uploading" });
  });

  it("dismissWorkspaceUpload removes a failed entry", async () => {
    mocks.runAtomCommand.mockResolvedValue(genericMintFailure());
    const file = makeFile("dismiss-me.txt");
    startWorkspaceUploads({ environmentId, cwd, files: [file], onUploaded: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const [uploadId] = findUpload("dismiss-me.txt")!;
    dismissWorkspaceUpload(uploadId);

    expect(uploadsById()[uploadId]).toBeUndefined();
  });
});
