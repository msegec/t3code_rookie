import {
  type EventId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/**
 * Shared ACP Task-tool → task.* synthesis for Cursor (and as a fallback for
 * other ACP adapters when native subagent notifications are absent).
 *
 * Wire shape (Cursor / Grok Task tool):
 * - session/update → tool_call / tool_call_update, often kind: "other"
 * - title: "Task: ..."
 * - rawInput: { _toolName: "task" } (case-insensitive)
 */

export interface AcpTaskToolTrackState {
  readonly seenIds: Set<string>;
  readonly completedIds: Set<string>;
}

export function emptyAcpTaskToolTrackState(): AcpTaskToolTrackState {
  return {
    seenIds: new Set(),
    completedIds: new Set(),
  };
}

export function isAcpTaskToolCall(toolCall: AcpToolCallState): boolean {
  const rawInput = toolCall.data.rawInput;
  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "_toolName" in rawInput &&
    typeof rawInput._toolName === "string"
  ) {
    return rawInput._toolName.trim().toLowerCase() === "task";
  }
  return typeof toolCall.title === "string" && /^task:/i.test(toolCall.title.trim());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stripTaskTitlePrefix(title: string): string | undefined {
  const stripped = title.replace(/^task:\s*/i, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

function taskTitleFromToolCall(toolCall: AcpToolCallState): string | undefined {
  const fromTitle = toolCall.title ? stripTaskTitlePrefix(toolCall.title) : undefined;
  if (fromTitle) {
    return fromTitle;
  }
  const rawInput = asRecord(toolCall.data.rawInput);
  if (!rawInput) {
    return undefined;
  }
  return (
    readOptionalString(rawInput.description) ??
    readOptionalString(rawInput.prompt) ??
    readOptionalString(rawInput.task)
  );
}

function taskRoleFromRawInput(rawInput: unknown): string | undefined {
  const record = asRecord(rawInput);
  if (!record) {
    return undefined;
  }
  return (
    readOptionalString(record.role) ??
    readOptionalString(record.subagent_type) ??
    readOptionalString(record.subagentType)
  );
}

function taskModelFromRawInput(rawInput: unknown): string | undefined {
  return readOptionalString(asRecord(rawInput)?.model);
}

function taskLinkageFromToolCall(toolCall: AcpToolCallState) {
  const title = taskTitleFromToolCall(toolCall);
  const role = taskRoleFromRawInput(toolCall.data.rawInput);
  const model = taskModelFromRawInput(toolCall.data.rawInput);
  return {
    taskType: "subagent" as const,
    ...(title ? { title } : {}),
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    toolUseId: toolCall.toolCallId,
    timelineBypass: true as const,
  };
}

export type AcpTaskToolEventSpec =
  | {
      readonly type: "task.started";
      readonly payload: {
        readonly taskId: RuntimeTaskId;
        readonly description?: string;
        readonly taskType: "subagent";
        readonly title?: string;
        readonly role?: string;
        readonly model?: string;
        readonly toolUseId: string;
        readonly timelineBypass: true;
      };
    }
  | {
      readonly type: "task.completed";
      readonly payload: {
        readonly taskId: RuntimeTaskId;
        readonly status: "completed" | "failed";
        readonly summary?: string;
        readonly taskType: "subagent";
        readonly title?: string;
        readonly role?: string;
        readonly model?: string;
        readonly toolUseId: string;
        readonly timelineBypass: true;
      };
    };

/**
 * Advances tracker state for one ACP tool_call / tool_call_update and returns
 * zero or more task.* specs. First-seen terminal still emits started then completed.
 * Intermediate in-progress updates after start are silent (no progress spam).
 */
export function advanceAcpTaskToolTracker(
  state: AcpTaskToolTrackState,
  toolCall: AcpToolCallState,
): ReadonlyArray<AcpTaskToolEventSpec> {
  if (!isAcpTaskToolCall(toolCall)) {
    return [];
  }
  const taskId = toolCall.toolCallId.trim();
  if (!taskId || state.completedIds.has(taskId)) {
    return [];
  }

  const linkage = taskLinkageFromToolCall(toolCall);
  const runtimeTaskId = RuntimeTaskId.make(taskId);
  const events: Array<AcpTaskToolEventSpec> = [];

  if (!state.seenIds.has(taskId)) {
    state.seenIds.add(taskId);
    events.push({
      type: "task.started",
      payload: {
        taskId: runtimeTaskId,
        ...(linkage.title ? { description: linkage.title } : {}),
        ...linkage,
      },
    });
  }

  const terminal =
    toolCall.status === "completed"
      ? ("completed" as const)
      : toolCall.status === "failed"
        ? ("failed" as const)
        : undefined;

  if (terminal === undefined) {
    return events;
  }

  state.completedIds.add(taskId);
  const summary = readOptionalString(toolCall.detail);
  events.push({
    type: "task.completed",
    payload: {
      taskId: runtimeTaskId,
      status: terminal,
      ...(summary ? { summary } : {}),
      ...linkage,
    },
  });
  return events;
}

export function makeAcpTaskToolRuntimeEvent(input: {
  readonly stamp: { readonly eventId: EventId; readonly createdAt: string };
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly spec: AcpTaskToolEventSpec;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const base = {
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    raw: {
      source: "acp.jsonrpc" as const,
      method: "session/update",
      payload: input.rawPayload,
    },
  };
  if (input.spec.type === "task.started") {
    return {
      ...base,
      type: "task.started",
      payload: input.spec.payload,
    };
  }
  return {
    ...base,
    type: "task.completed",
    payload: input.spec.payload,
  };
}
