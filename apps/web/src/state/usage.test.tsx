import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({
  environments: [] as EnvironmentUsageStatus[],
  refreshUsage: vi.fn(async () => {}),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));
vi.mock("@t3tools/client-runtime/state/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/usage")>()),
  refreshUsage: testState.refreshUsage,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: (environmentId: unknown) => environmentId },
  readEnvironmentScope: () => true,
}));
vi.mock("./server", () => ({
  serverEnvironment: {
    refreshUsageRates: {},
    usageSummary: (args: unknown) => args,
  },
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};
const otherInput = { ...input, sinceDay: UsageDay.make("2026-09-03") };

function environment(
  id: string,
  cost: number | null,
  hostId = id,
  provider: UsageProviderKind = "codex",
  overrides: Partial<EnvironmentUsageStatus> = {},
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    needsCursorKeychainAccess: false,
    offline: false,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider,
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider,
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
let latest: UsageView;

function Probe({
  selected,
  hidden,
  window = input,
}: {
  selected: ReadonlySet<EnvironmentId> | null;
  hidden?: ReadonlySet<UsageProviderKind>;
  window?: typeof input;
}) {
  const usage = useUsage(window, selected, hidden);
  useLayoutEffect(() => {
    latest = usage;
  }, [usage]);
  return null;
}

async function render(
  selected: ReadonlySet<EnvironmentId> | null = null,
  window: typeof input = input,
) {
  await act(() => {
    renderer?.update(<Probe selected={selected} window={window} />);
  });
}

async function select(...ids: string[]) {
  await render(new Set(ids.map((id) => EnvironmentId.make(id))));
}

async function advancePastDeadline() {
  await act(() => vi.advanceTimersByTimeAsync(7_500));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.refreshUsage.mockClear();
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  await act(() => {
    renderer = create(<Probe selected={null} />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usage environment selection", () => {
  it("starts with all environments and adds results as they arrive", async () => {
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await render();
    expect(latest.merged.costUsd).toBe(70);
    expect(latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
    expect(latest.environments).toHaveLength(3);

    await render();
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await select("slow");
    expect(latest.isPending).toBe(true);
    expect(latest.merged.costUsd).toBe(0);

    await select();
    expect(latest.selectedEnvironments).toHaveLength(0);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await select("slow");
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await render();
    expect(latest.merged.costUsd).toBe(10);

    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await select("a");
    expect(latest.merged.costUsd).toBe(10);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });

  it("shows the last answered usage until the next window answers, for the same selection", async () => {
    const selected = new Set([EnvironmentId.make("a")]);
    await act(() => renderer?.update(<Probe selected={selected} />));
    expect(latest.shown?.merged.costUsd).toBe(10);

    // A new window that nothing has answered yet.
    const nextWindow = { ...input, sinceDay: UsageDay.make("2026-08-28") };
    testState.environments = [environment("a", null)];
    await act(() => renderer?.update(<Probe selected={selected} window={nextWindow} />));
    expect(latest.isPending).toBe(true);
    expect(latest.shown?.window).toBe(input);
    expect(latest.shown?.merged.costUsd).toBe(10);

    // A window that fails everywhere keeps it too.
    testState.environments = [{ ...environment("a", null), isPending: false, error: "Offline" }];
    await act(() => renderer?.update(<Probe selected={selected} window={nextWindow} />));
    expect(latest.isPending).toBe(false);
    expect(latest.shown?.window).toBe(input);
    expect(latest.shown?.merged.costUsd).toBe(10);

    // Once the new window answers, it replaces the kept one.
    testState.environments = [environment("a", 30)];
    await act(() => renderer?.update(<Probe selected={selected} window={nextWindow} />));
    expect(latest.shown?.window).toBe(nextWindow);
    expect(latest.shown?.merged.costUsd).toBe(30);

    // A different provider filter does not reuse usage merged with the old one.
    testState.environments = [environment("a", null)];
    await act(() =>
      renderer?.update(<Probe selected={selected} hidden={new Set(["claude"])} window={input} />),
    );
    expect(latest.shown).toBeNull();

    // Another selection has nothing of its own to show.
    testState.environments = [environment("a", null)];
    await select("a");
    expect(latest.shown).toBeNull();
  });
});

describe("usage provider filter", () => {
  it("drops hidden providers from totals and sessions, then restores them", async () => {
    testState.environments = [environment("a", 10), environment("c", 5, "c", "claude")];
    await act(() => renderer?.update(<Probe selected={null} hidden={new Set(["codex"])} />));
    expect(latest.merged.costUsd).toBe(5);
    expect(latest.merged.sessions).toBe(1);
    expect(latest.merged.providers.map((entry) => entry.provider)).toEqual(["claude"]);

    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(15);
    expect(latest.merged.sessions).toBe(2);
  });
});

describe("usage offline deadline", () => {
  it("marks disconnected environments offline without hiding answers", async () => {
    testState.environments = [
      environment("answered", 10),
      environment("away", null, "away", "codex", { isConnected: false }),
    ];
    await render();
    expect(latest.isPartial).toBe(true);

    await advancePastDeadline();

    expect(latest.environments.find((entry) => entry.label === "away")?.offline).toBe(true);
    expect(latest.merged.costUsd).toBe(10);
    expect(latest.isPartial).toBe(false);
    expect(latest.isUnreachable).toBe(false);
  });

  it("does not mark a connected environment offline while it scans", async () => {
    testState.environments = [environment("slow", null)];
    await render();
    await advancePastDeadline();

    expect(latest.environments[0]?.offline).toBe(false);
    expect(latest.isPending).toBe(true);
    expect(latest.isUnreachable).toBe(false);
  });

  it("reports unreachable for an unanswered selection", async () => {
    testState.environments = [
      environment("ready", 10),
      environment("away", null, "away", "codex", { isConnected: false }),
    ];
    await select("away");
    await advancePastDeadline();

    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
    expect(latest.isUnreachable).toBe(true);
  });

  it("restarts the deadline when an environment appears", async () => {
    testState.environments = [
      environment("answered", 10),
      environment("away", null, "away", "codex", { isConnected: false }),
    ];
    await render();
    await advancePastDeadline();
    expect(latest.environments.find((entry) => entry.label === "away")?.offline).toBe(true);

    testState.environments = [
      ...testState.environments,
      environment("new", null, "new", "codex", { isConnected: false }),
    ];
    await render();
    expect(latest.environments.find((entry) => entry.label === "new")?.offline).toBe(false);

    await advancePastDeadline();
    expect(latest.environments.find((entry) => entry.label === "new")?.offline).toBe(true);
  });

  it("restarts the deadline when revisiting a window", async () => {
    testState.environments = [environment("away", null, "away", "codex", { isConnected: false })];
    await render();
    await advancePastDeadline();
    expect(latest.environments[0]?.offline).toBe(true);

    await render(null, otherInput);
    await render();
    expect(latest.environments[0]?.offline).toBe(false);
  });

  it("restarts the deadline on refresh", async () => {
    testState.environments = [
      environment("answered", 10),
      environment("away", null, "away", "codex", { isConnected: false }),
    ];
    await render();
    await advancePastDeadline();
    expect(latest.environments.find((entry) => entry.label === "away")?.offline).toBe(true);

    await act(() => latest.refresh(otherInput));

    expect(testState.refreshUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentIds: [EnvironmentId.make("answered"), EnvironmentId.make("away")],
        input: otherInput,
      }),
    );
    expect(latest.environments.find((entry) => entry.label === "away")?.offline).toBe(false);
  });
});
