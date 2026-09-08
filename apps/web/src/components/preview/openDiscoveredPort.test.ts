import { EnvironmentId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), release: vi.fn(), openBrowser: vi.fn() }));
vi.mock("~/browser/browserTargetResolver", () => ({ resolveDiscoveredServerUrl: mocks.resolve }));
vi.mock("~/browser/previewGateway", () => ({ releaseUnusedPreviewGateway: mocks.release }));
vi.mock("~/browserHistoryStore", () => ({ recordVisitForThread: vi.fn() }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  rememberPreviewUrl: vi.fn(),
}));
vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({}),
  browserDefaultOpenViewport: () => ({ _tag: "fixed", width: 1280, height: 720 }),
}));
import { openDiscoveredPort } from "./openDiscoveredPort";
const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const port: DiscoveredLocalServer = {
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: null,
  pid: null,
  terminal: null,
};

beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue("http://opaque.localhost:3773/");
  mocks.release.mockReset();
});

describe("discovered port preview", () => {
  it("returns a failure result when target resolution fails without opening a tab", async () => {
    const error = new Error("Preview gateway unavailable");
    mocks.resolve.mockRejectedValue(error);
    const openPreview = vi.fn();
    const result = await openDiscoveredPort({ threadRef, port, openPreview });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBe(error);
    expect(openPreview).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("preserves default viewport selection for the resolved target", async () => {
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
    const result = await openDiscoveredPort({ threadRef, port, openPreview });
    expect(result._tag).toBe("Success");
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "http://opaque.localhost:3773/",
        viewport: { _tag: "fixed", width: 1280, height: 720 },
      },
    });
  });

  it("releases the resolved gateway and returns failure when opening throws", async () => {
    const error = new Error("Tab unavailable");
    const result = await openDiscoveredPort({
      threadRef,
      port,
      openPreview: async () => {
        throw error;
      },
    });
    expect(result._tag).toBe("Failure");
    expect(mocks.release).toHaveBeenCalledWith("http://opaque.localhost:3773/");
  });
});
