import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { browserAutomationContext } from "./browserAutomationContext";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const targetFields = { environmentId, label: "Remote project" };
const snapshot = {
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/server/project",
    },
  ],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      worktreePath: "/server/worktrees/feature",
    },
  ],
};

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
