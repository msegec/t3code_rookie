import { ProviderDriverKind, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  advanceAcpTaskToolTracker,
  emptyAcpTaskToolTrackState,
  isAcpTaskToolCall,
  makeAcpTaskToolRuntimeEvent,
} from "./AcpTaskSubagents.ts";

function toolCall(
  partial: Partial<AcpToolCallState> & Pick<AcpToolCallState, "toolCallId">,
): AcpToolCallState {
  const { data, ...rest } = partial;
  return {
    ...rest,
    data: data ?? {},
  };
}

describe("AcpTaskSubagents", () => {
  it("detects Task tools by _toolName and Task: title", () => {
    expect(
      isAcpTaskToolCall(
        toolCall({
          toolCallId: "t1",
          title: "Custom MCP tool",
          data: { rawInput: { _toolName: "task" } },
        }),
      ),
    ).toBe(true);
    expect(
      isAcpTaskToolCall(
        toolCall({
          toolCallId: "t2",
          title: "Task: research the flake",
          data: {},
        }),
      ),
    ).toBe(true);
    expect(
      isAcpTaskToolCall(
        toolCall({
          toolCallId: "t3",
          data: { rawInput: { _toolName: "Task" } },
        }),
      ),
    ).toBe(true);
    expect(
      isAcpTaskToolCall(
        toolCall({
          toolCallId: "t4",
          title: "Custom MCP tool",
          data: { rawInput: { _toolName: "mcp__x" } },
        }),
      ),
    ).toBe(false);
    expect(
      isAcpTaskToolCall(
        toolCall({
          toolCallId: "t5",
          kind: "search",
          title: "Searched files",
          data: {},
        }),
      ),
    ).toBe(false);
  });

  it("emits task.started then task.completed with timelineBypass", () => {
    const state = emptyAcpTaskToolTrackState();
    const started = advanceAcpTaskToolTracker(
      state,
      toolCall({
        toolCallId: "toolu_task_1",
        kind: "other",
        status: "inProgress",
        title: "Task: Subagent task",
        data: { rawInput: { _toolName: "task", role: "explore", model: "composer-1" } },
      }),
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "toolu_task_1",
        taskType: "subagent",
        title: "Subagent task",
        description: "Subagent task",
        role: "explore",
        model: "composer-1",
        toolUseId: "toolu_task_1",
        timelineBypass: true,
      },
    });
    expect(started[0]?.payload).not.toHaveProperty("parentAgentId");

    expect(
      advanceAcpTaskToolTracker(
        state,
        toolCall({
          toolCallId: "toolu_task_1",
          kind: "other",
          status: "inProgress",
          title: "Task: Subagent task",
          data: { rawInput: { _toolName: "task" } },
        }),
      ),
    ).toEqual([]);

    const completed = advanceAcpTaskToolTracker(
      state,
      toolCall({
        toolCallId: "toolu_task_1",
        kind: "other",
        status: "completed",
        title: "Task: Subagent task",
        detail: "done",
        data: { rawInput: { _toolName: "task" } },
      }),
    );
    expect(completed).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: "toolu_task_1",
          status: "completed",
          summary: "done",
          taskType: "subagent",
          title: "Subagent task",
          toolUseId: "toolu_task_1",
          timelineBypass: true,
        },
      },
    ]);

    expect(
      advanceAcpTaskToolTracker(
        state,
        toolCall({
          toolCallId: "toolu_task_1",
          status: "completed",
          title: "Task: Subagent task",
          data: { rawInput: { _toolName: "task" } },
        }),
      ),
    ).toEqual([]);
  });

  it("emits started then completed when first seen as terminal", () => {
    const state = emptyAcpTaskToolTrackState();
    const events = advanceAcpTaskToolTracker(
      state,
      toolCall({
        toolCallId: "toolu_task_fail",
        status: "failed",
        title: "task: dig into the flake",
        data: {},
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(events[1]).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: "toolu_task_fail",
        status: "failed",
        title: "dig into the flake",
        timelineBypass: true,
      },
    });
  });

  it("reports unknown background completion and accepts a later explicit result", () => {
    const state = emptyAcpTaskToolTrackState();
    const background = toolCall({
      toolCallId: "background-task",
      title: "Task: review changes",
      status: "completed",
      data: { rawOutput: { isBackground: true } },
    });
    const events = advanceAcpTaskToolTracker(state, background);
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.progress"]);
    expect(events[1]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "background-task",
        status: "unknown",
        description: "review changes",
        summary: "Cursor does not report background task completion.",
      },
    });
    expect(advanceAcpTaskToolTracker(state, background)).toEqual([]);
    expect(advanceAcpTaskToolTracker(state, { ...background, data: {} })).toEqual([]);
    expect(
      advanceAcpTaskToolTracker(state, {
        ...background,
        data: { rawOutput: { isBackground: false } },
      }),
    ).toMatchObject([{ type: "task.completed", payload: { status: "completed" } }]);
  });

  it("accepts failure after background acknowledgement", () => {
    const state = emptyAcpTaskToolTrackState();
    const task = toolCall({
      toolCallId: "background-failure",
      title: "Task: review",
      status: "completed",
      data: { rawOutput: { isBackground: true } },
    });
    advanceAcpTaskToolTracker(state, task);
    expect(advanceAcpTaskToolTracker(state, { ...task, status: "failed" })).toMatchObject([
      { type: "task.completed", payload: { status: "failed" } },
    ]);
  });

  it("builds runtime events with acp.jsonrpc raw source", () => {
    const state = emptyAcpTaskToolTrackState();
    const [spec] = advanceAcpTaskToolTracker(
      state,
      toolCall({
        toolCallId: "toolu_task_2",
        status: "inProgress",
        data: { rawInput: { _toolName: "task", description: "from input" } },
      }),
    );
    expect(spec).toBeDefined();
    if (!spec) {
      return;
    }
    expect(
      makeAcpTaskToolRuntimeEvent({
        stamp: { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" },
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        spec,
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "task.started",
      provider: "cursor",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        taskId: "toolu_task_2",
        title: "from input",
        timelineBypass: true,
      },
      raw: {
        source: "acp.jsonrpc",
        method: "session/update",
      },
    });
  });
});
