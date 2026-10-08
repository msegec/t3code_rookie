import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  PreviewAutomationStatus,
  ThreadId,
} from "@t3tools/contracts";

const connectionKinds = {
  PrimaryConnectionTarget: "primary",
  BearerConnectionTarget: "bearer",
  RelayConnectionTarget: "relay",
  SshConnectionTarget: "ssh",
} as const;

interface ShellWorkspaceFacts {
  readonly projects: ReadonlyArray<
    Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
  >;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath">
  >;
}

export function browserAutomationContext(
  connection: PreparedConnection | null,
  snapshot: ShellWorkspaceFacts | null,
  threadId: ThreadId,
): Pick<PreviewAutomationStatus, "connectionKind" | "environmentLabel" | "workspace"> {
  const thread = snapshot?.threads.find((entry) => entry.id === threadId);
  const project = thread && snapshot?.projects.find((entry) => entry.id === thread.projectId);
  return {
    ...(connection
      ? {
          connectionKind: connectionKinds[connection.target._tag],
          environmentLabel: connection.label,
        }
      : {}),
    ...(thread && project
      ? {
          workspace: {
            projectId: project.id,
            projectName: project.title,
            projectDirectory: project.workspaceRoot,
            workingDirectory: thread.worktreePath ?? project.workspaceRoot,
          },
        }
      : {}),
  };
}
