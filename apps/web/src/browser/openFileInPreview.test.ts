import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openFileInPreview,
  openUrlInPreview,
  resolveWorkspaceFilePreviewUrl,
} from "./openFileInPreview";

const mocks = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  resolve: vi.fn(),
  release: vi.fn(),
  openBrowser: vi.fn(),
  rememberPreviewUrl: vi.fn(),
  applyPreviewServerSnapshot: vi.fn(),
}));

vi.mock("./browserTargetResolver", () => ({ resolveBrowserNavigationTarget: mocks.resolve }));
vi.mock("./previewGateway", () => ({ releaseUnusedPreviewGateway: mocks.release }));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: mocks.supported,
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  applyPreviewServerSnapshot: mocks.applyPreviewServerSnapshot,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));

const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("worktree-thread"),
};
const relativeUrl = "/api/assets/fixture-capability/design.html";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supported.mockReturnValue(true);
  mocks.resolve.mockReset().mockResolvedValue({ resolvedUrl: "http://opaque.localhost:3773/app" });
});

describe("workspace file browser navigation", () => {
  it.each([
    "http://127.0.0.1:3773",
    "http://127.0.0.1:45678",
    "http://100.65.180.100:3773",
    "https://relay.example.com/environment/",
  ])("uses the existing environment endpoint %s and invoking thread", async (httpBaseUrl) => {
    const createAssetUrl = vi.fn(async () => AsyncResult.success({ relativeUrl, expiresAt: 123 }));
    const result = await resolveWorkspaceFilePreviewUrl({
      threadRef,
      filePath: "site/design.html",
      httpBaseUrl,
      createAssetUrl,
    });

    expect(createAssetUrl).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "site/design.html",
        },
      },
    });
    expect(result).toMatchObject({
      _tag: "Success",
      value: new URL(relativeUrl, httpBaseUrl).toString(),
    });
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });

  it("rejects unsupported runtimes before requesting an asset URL", async () => {
    mocks.supported.mockReturnValue(false);
    const createAssetUrl = vi.fn();
    const result = await resolveWorkspaceFilePreviewUrl({
      threadRef,
      filePath: "design.html",
      httpBaseUrl: "http://localhost:3773",
      createAssetUrl,
    });
    expect(result._tag).toBe("Failure");
    expect(createAssetUrl).not.toHaveBeenCalled();
  });

  it("preserves asset access failures without navigating", async () => {
    const cause = Cause.fail(new Error("Workspace asset was not found."));
    const openPreview = vi.fn();
    const result = await openFileInPreview({
      threadRef,
      filePath: "missing.html",
      httpBaseUrl: "https://relay.example.com",
      createAssetUrl: async () => AsyncResult.failure(cause),
      openPreview,
    });
    expect(result).toMatchObject({ _tag: "Failure", cause });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("rejects invalid environment asset URLs without opening a tab", async () => {
    const openPreview = vi.fn();
    const result = await openFileInPreview({
      threadRef,
      filePath: "design.html",
      httpBaseUrl: "invalid origin",
      createAssetUrl: async () => AsyncResult.success({ relativeUrl, expiresAt: 123 }),
      openPreview,
    });
    expect(result._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
  });

  it.each(["https://relay.example.com", "http://127.0.0.1:48219"])(
    "keeps manual file preview on its signed asset route %s",
    async (httpBaseUrl) => {
      const snapshot: PreviewSessionSnapshot = {
        threadId: threadRef.threadId,
        tabId: "tab-1",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-09-09T00:00:00.000Z",
      };
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const result = await openFileInPreview({
        threadRef,
        filePath: "design.html",
        httpBaseUrl,
        createAssetUrl: async () => AsyncResult.success({ relativeUrl, expiresAt: 123 }),
        openPreview,
      });
      expect(result._tag).toBe("Success");
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, url: `${httpBaseUrl}${relativeUrl}` },
      });
      expect(mocks.openBrowser).toHaveBeenCalledExactlyOnceWith(threadRef, snapshot.tabId);
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );
});

describe("chat URL preview navigation", () => {
  it.each(["http://localhost:5173/app", "https://example.com/app"])(
    "resolves URL %s in the invoking environment before opening",
    async (url) => {
      const resolvedUrl = url.startsWith("https:") ? url : "http://opaque.localhost:3773/app";
      mocks.resolve.mockResolvedValue({ resolvedUrl });
      const openPreview = vi.fn(async () =>
        AsyncResult.success({
          threadId: threadRef.threadId,
          tabId: "tab",
          navStatus: { _tag: "Idle" as const },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-09-09T00:00:00.000Z",
        }),
      );
      const result = await openUrlInPreview({ threadRef, url, openPreview });
      expect(result._tag).toBe("Success");
      expect(mocks.resolve).toHaveBeenCalledWith(
        threadRef.environmentId,
        { kind: "url", url },
        threadRef.threadId,
      );
      expect(openPreview).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, url: resolvedUrl },
      });
    },
  );

  it("does not open the raw target when gateway resolution fails", async () => {
    mocks.resolve.mockRejectedValue(new Error("Environment disconnected"));
    const openPreview = vi.fn();
    const result = await openUrlInPreview({ threadRef, url: "http://localhost:5173", openPreview });
    expect(result._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("releases an unused gateway when the preview command fails", async () => {
    const result = await openUrlInPreview({
      threadRef,
      url: "http://localhost:5173",
      openPreview: async () => AsyncResult.failure(Cause.fail(new Error("Tab unavailable"))),
    });
    expect(result._tag).toBe("Failure");
    expect(mocks.release).toHaveBeenCalledWith("http://opaque.localhost:3773/app");
  });
});
