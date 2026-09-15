import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { browserAutomationContext } from "./browserAutomationContext";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const targetFields = { environmentId, label: "Remote project" };
const snapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
  snapshotSequence: 0,
  updatedAt: "2026-09-09T00:00:00.000Z",
  projects: [
    {
      id: "project-1",
      title: "Project",
      workspaceRoot: "/server/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
  threads: [
    {
      id: threadId,
      projectId: "project-1",
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      branch: "feature",
      worktreePath: "/server/worktrees/feature",
      latestTurn: null,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
});

describe("browserAutomationContext", () => {
  it.each([
    [
      new PrimaryConnectionTarget({
        ...targetFields,
        httpBaseUrl: "https://remote.test",
        wsBaseUrl: "wss://remote.test",
      }),
      "primary",
    ],
    [new BearerConnectionTarget({ ...targetFields, connectionId: "saved-1" }), "bearer"],
    [new RelayConnectionTarget(targetFields), "relay"],
    [new SshConnectionTarget({ ...targetFields, connectionId: "saved-ssh" }), "ssh"],
  ] as const)("uses the prepared connection type for %s", (target, expectedKind) => {
    const connection: PreparedConnection = {
      ...targetFields,
      httpBaseUrl: "http://localhost:4567/capability",
      socketUrl: "ws://localhost:4567/private",
      httpAuthorization: { _tag: "Bearer", token: "never-report-this" },
      target,
    };
    expect(browserAutomationContext(connection, null, threadId)).toEqual({
      connectionKind: expectedKind,
      environmentLabel: "Remote project",
    });
  });

  it("reports the thread worktree rather than the project root", () => {
    expect(browserAutomationContext(null, snapshot, threadId).workspace).toEqual({
      projectId: "project-1",
      projectName: "Project",
      projectDirectory: "/server/project",
      workingDirectory: "/server/worktrees/feature",
    });
    const withoutWorktree = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({ ...thread, worktreePath: null })),
    };
    expect(
      browserAutomationContext(null, withoutWorktree, threadId).workspace?.workingDirectory,
    ).toBe("/server/project");
  });

  it("leaves unavailable projection facts absent", () => {
    expect(browserAutomationContext(null, null, threadId)).toEqual({});
    expect(browserAutomationContext(null, snapshot, ThreadId.make("other-thread"))).toEqual({});
  });
});
