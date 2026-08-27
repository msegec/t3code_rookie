import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  statuses: [] as unknown[],
  refresh: vi.fn(),
  usageSummary: vi.fn((args: unknown) => args),
}));

// The hook reads per-environment statuses through one derived atom; feeding
// that read directly keeps the test on the hook's own logic (deadline timer,
// offline mapping, scan reset) instead of the atom runtime.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.statuses }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("./presentation", () => ({ environmentPresentations: { presentationsAtom: {} } }));
vi.mock("./server", () => ({ serverEnvironment: { usageSummary: mocks.usageSummary } }));

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const WINDOW: UsageSummaryInput = {
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-31" as UsageDay,
  timeZone: "UTC",
};
const OTHER_WINDOW: UsageSummaryInput = { ...WINDOW, sinceDay: "2026-07-01" as UsageDay };

function summary(hostId = "host-a"): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-08-27T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: WINDOW.sinceDay,
    untilDay: WINDOW.untilDay,
    buckets: [
      {
        day: "2026-08-07" as UsageDay,
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 1000,
          cacheCreationTokens: 10,
          outputTokens: 50,
          reasoningTokens: 0,
        },
        costUsd: 10,
        cacheSavingsUsd: 2,
        costSource: "modelPriced",
        records: 5,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId,
          provider: "claude",
          resolvedHomePath: `/${hostId}/.claude`,
          volumeId: `vol-${hostId}`,
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function status(
  id: string,
  overrides: Partial<EnvironmentUsageStatus> = {},
): EnvironmentUsageStatus {
  return {
    environmentId: id as EnvironmentId,
    label: id,
    isPending: true,
    error: null,
    summary: null,
    connected: false,
    offline: false,
    ...overrides,
  };
}

// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

let view: UsageView;
function Probe({ input }: { readonly input: UsageSummaryInput }) {
  view = useUsage(input);
  return null;
}

async function mount(input: UsageSummaryInput = WINDOW) {
  const document = installTestDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div") as unknown as Element);
  const render = (nextInput: UsageSummaryInput = input) =>
    act(() => root.render(<Probe input={nextInput} />));
  await render();
  return {
    render,
    unmount: () => act(() => root.unmount()),
  };
}

const advancePastDeadline = () => act(() => vi.advanceTimersByTimeAsync(7_500));

const byId = (id: string) => view.environments.find((entry) => entry.environmentId === id);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.refresh.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useUsage offline deadline", () => {
  it("marks a disconnected device offline once the deadline passes", async () => {
    mocks.statuses = [
      status("env-answered", { summary: summary(), isPending: false }),
      status("env-away"),
    ];
    const { unmount } = await mount();
    try {
      expect(view.isPartial).toBe(true);
      expect(byId("env-away")?.offline).toBe(false);

      await advancePastDeadline();

      expect(byId("env-away")?.offline).toBe(true);
      expect(view.isPartial).toBe(false);
      expect(view.isPending).toBe(false);
      expect(view.isUnreachable).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("merges a late answer and clears the offline flag", async () => {
    mocks.statuses = [
      status("env-answered", { summary: summary(), isPending: false }),
      status("env-away"),
    ];
    const { render, unmount } = await mount();
    try {
      await advancePastDeadline();
      expect(byId("env-away")?.offline).toBe(true);
      expect(view.merged.contributingEnvironments).toHaveLength(1);

      mocks.statuses = [
        status("env-answered", { summary: summary(), isPending: false }),
        status("env-away", { summary: summary("host-b"), isPending: false }),
      ];
      await render();

      expect(byId("env-away")?.offline).toBe(false);
      expect(view.merged.contributingEnvironments).toHaveLength(2);
    } finally {
      await unmount();
    }
  });

  it("restarts the grace period on refresh", async () => {
    mocks.statuses = [
      status("env-answered", { summary: summary(), isPending: false }),
      status("env-away"),
    ];
    const { unmount } = await mount();
    try {
      await advancePastDeadline();
      expect(byId("env-away")?.offline).toBe(true);

      await act(() => view.refresh());

      expect(mocks.refresh).toHaveBeenCalledTimes(2);
      expect(byId("env-away")?.offline).toBe(false);

      await advancePastDeadline();
      expect(byId("env-away")?.offline).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("reports unreachable instead of zero totals when no device answers", async () => {
    mocks.statuses = [status("env-away"), status("env-also-away")];
    const { unmount } = await mount();
    try {
      expect(view.isPending).toBe(true);
      expect(view.isUnreachable).toBe(false);

      await advancePastDeadline();

      expect(view.isPending).toBe(false);
      expect(view.isPartial).toBe(false);
      expect(view.isUnreachable).toBe(true);
      expect(view.environments.every((entry) => entry.offline)).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("gives a revisited window a fresh grace period", async () => {
    mocks.statuses = [status("env-away")];
    const { render, unmount } = await mount();
    try {
      await advancePastDeadline();
      expect(byId("env-away")?.offline).toBe(true);

      await render(OTHER_WINDOW);
      await render(WINDOW);

      expect(byId("env-away")?.offline).toBe(false);

      await advancePastDeadline();
      expect(byId("env-away")?.offline).toBe(true);
    } finally {
      await unmount();
    }
  });
});
