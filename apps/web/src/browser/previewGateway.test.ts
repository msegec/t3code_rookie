import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  subscribers: new Map<string, Set<(value: unknown) => void>>(),
  connections: new Map<string, unknown>(),
  issue: vi.fn(),
  register: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "primary" }));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => true,
  previewStateAtom: () => "preview",
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: (id: string) => mocks.connections.get(id) ?? null,
  environmentSession: { preparedConnectionValueAtom: (id: string) => id },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (key: string) => mocks.values.get(key),
    subscribe: (key: string, callback: (value: unknown) => void) => {
      const set = mocks.subscribers.get(key) ?? new Set();
      set.add(callback);
      mocks.subscribers.set(key, set);
      return () => set.delete(callback);
    },
  },
}));
vi.mock("@t3tools/client-runtime/state/previewGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/previewGateway")>()),
  createPreviewGatewayEnvironmentAtoms: () => ({
    issue: { run: mocks.issue },
    register: { run: mocks.register },
    revoke: { run: mocks.revoke },
  }),
}));
const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const origin = "http://opaque.localhost:3773";
function publish(key: string, value: unknown) {
  mocks.values.set(key, value);
  for (const callback of mocks.subscribers.get(key) ?? []) callback(value);
}

beforeEach(() => {
  vi.resetModules();
  mocks.connections.clear();
  mocks.values.clear();
  mocks.subscribers.clear();
  mocks.connections.set("local", { httpBaseUrl: "http://127.0.0.1:3773" });
  mocks.connections.set("remote", { httpBaseUrl: "https://remote.relay.t3.codes" });
  mocks.values.set("primary", EnvironmentId.make("local"));
  mocks.values.set("preview", { sessions: {} });
  mocks.issue.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { path: "/api/preview/cap/", expiresAt: Date.now() + 900_000 },
  });
  mocks.register
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { origin, expiresAt: Date.now() + 900_000 } });
  mocks.revoke.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
});

describe("preview gateway lease lifecycle", () => {
  it("shares concurrent navigation acquisition and one route", async () => {
    const { resolvePreviewGateway } = await import("./previewGateway");
    expect(
      await Promise.all([
        resolvePreviewGateway(threadRef, 5173),
        resolvePreviewGateway(threadRef, 5173),
      ]),
    ).toEqual([origin, origin]);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it("releases a failed initial load and its subscriptions", async () => {
    const { resolvePreviewGateway } = await import("./previewGateway");
    await resolvePreviewGateway(threadRef, 5173);
    publish("preview", {
      sessions: { tab: { navStatus: { _tag: "LoadFailed", url: `${origin}/` } } },
    });
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect([...mocks.subscribers.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("releases a target when navigation fails before the tab opens", async () => {
    const { resolvePreviewGateway, releaseUnusedPreviewGateway } = await import("./previewGateway");
    const url = await resolvePreviewGateway(threadRef, 5173);
    releaseUnusedPreviewGateway(url);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    await resolvePreviewGateway(threadRef, 5173);
    expect(mocks.issue).toHaveBeenCalledTimes(2);
  });

  it("keeps shared routes until the final tab closes", async () => {
    const { resolvePreviewGateway } = await import("./previewGateway");
    await resolvePreviewGateway(threadRef, 5173);
    const session = { navStatus: { _tag: "Success", url: `${origin}/` } };
    publish("preview", { sessions: { first: session, second: session } });
    publish("preview", { sessions: { second: session } });
    expect(mocks.revoke).not.toHaveBeenCalled();
    publish("preview", { sessions: {} });
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("keeps an active route after its acquisition expiry when another target opens", async () => {
    const { resolvePreviewGateway, previewGatewayTargetPort } = await import("./previewGateway");
    await resolvePreviewGateway(threadRef, 5173);
    publish("preview", {
      sessions: { tab: { navStatus: { _tag: "Success", url: `${origin}/` } } },
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    try {
      mocks.register.mockResolvedValue({
        _tag: "Success",
        value: { origin: "http://other.localhost:3773", expiresAt: Date.now() + 900_000 },
      });
      await resolvePreviewGateway(threadRef, 3000);
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(previewGatewayTargetPort(threadRef, origin)).toBe(5173);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects using another thread's gateway origin", async () => {
    const { resolvePreviewGateway, previewGatewayTargetPort } = await import("./previewGateway");
    await resolvePreviewGateway(threadRef, 5173);
    expect(previewGatewayTargetPort(threadRef, origin)).toBe(5173);
    expect(() =>
      previewGatewayTargetPort({ ...threadRef, threadId: ThreadId.make("other") }, origin),
    ).toThrow("another thread");
  });

  it("releases on connection replacement and reacquires on the new endpoint", async () => {
    const { resolvePreviewGateway } = await import("./previewGateway");
    await resolvePreviewGateway(threadRef, 5173);
    mocks.connections.set("remote", { httpBaseUrl: "http://127.0.0.1:48219" });
    publish("remote", {});
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    await resolvePreviewGateway(threadRef, 5173);
    expect(mocks.register).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({ gatewayUrl: "http://127.0.0.1:48219/api/preview/cap/" }),
      }),
    );
  });
});
