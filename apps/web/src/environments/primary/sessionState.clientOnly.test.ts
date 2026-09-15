import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AuthSessionState } from "@t3tools/contracts";

const { fetchSessionState, captureAtom } = vi.hoisted(() => ({
  fetchSessionState: vi.fn(async () => ({ authenticated: false })),
  captureAtom: vi.fn<(atom: Atom.Atom<AsyncResult.AsyncResult<AuthSessionState | null>>) => void>(),
}));

vi.mock("./auth", () => ({ fetchSessionState }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<AsyncResult.AsyncResult<AuthSessionState | null>>) => {
    captureAtom(atom);
    return AsyncResult.initial();
  },
}));
vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { usePrimarySessionState } from "./sessionState";

async function readSession() {
  usePrimarySessionState();
  const atom = captureAtom.mock.calls[0]?.[0];
  if (atom === undefined) throw new Error("Primary session hook did not read its atom.");
  const registry = AtomRegistry.make();
  try {
    return await new Promise<AuthSessionState | null>((resolve, reject) => {
      registry.subscribe(
        atom,
        (result) => {
          if (result._tag === "Success") resolve(result.value);
          if (result._tag === "Failure") reject(result.cause);
        },
        { immediate: true },
      );
    });
  } finally {
    registry.dispose();
  }
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("client-only primary session", () => {
  it("returns no session without requesting primary authentication", async () => {
    vi.stubGlobal("window", { desktopBridge: { getLocalEnvironmentEnabled: () => false } });
    expect(await readSession()).toBeNull();
    expect(fetchSessionState).not.toHaveBeenCalled();
  });

  it.each([
    { name: "enabled desktop", desktopBridge: { getLocalEnvironmentEnabled: () => true } },
    { name: "legacy desktop bridge", desktopBridge: {} },
    { name: "web client", desktopBridge: undefined },
  ])("still fetches the primary session for $name", async ({ desktopBridge }) => {
    vi.stubGlobal("window", { desktopBridge });
    expect(await readSession()).toEqual({ authenticated: false });
    expect(fetchSessionState).toHaveBeenCalledOnce();
  });
});
