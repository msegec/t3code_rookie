import { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  applyGrokSubagentUpdate,
  applyGrokWorkflowUpdate,
  emptyGrokSubagentTrackState,
  grokWorkflowMemberTaskId,
  parseXAiSubagentUpdate,
  parseXAiWorkflowUpdated,
} from "./GrokAcpSubagents.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("parseXAiSubagentUpdate", () => {
  it("reads snake_case subagent_spawned envelopes", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionId: "parent-session",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        subagent_type: "explore",
        description: "Search the codebase",
        child_session_id: "child-session-1",
        model: "grok-4.6",
      },
    });
    expect(parsed).toEqual({
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: "child-session-1",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: undefined,
      error: undefined,
      tokensUsed: undefined,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
  });

  it("accepts PascalCase tags and camelCase fields", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionUpdate: "SubagentFinished",
      subagentId: "child-2",
      agentType: "plan",
      status: "failed",
      error: "depth limit",
      tokensUsed: 12,
      durationMs: 40,
      toolCallCount: 3,
    });
    expect(parsed?.kind).toBe("finished");
    expect(parsed?.subagentId).toBe("child-2");
    expect(parsed?.role).toBe("plan");
    expect(parsed?.error).toBe("depth limit");
    expect(parsed?.tokensUsed).toBe(12);
    expect(parsed?.toolCallCount).toBe(3);
  });

  it("ignores unrelated session extras", () => {
    expect(
      parseXAiSubagentUpdate({
        update: { sessionUpdate: "auto_compact_started", tokens_used: 100 },
      }),
    ).toBeUndefined();
  });
});

describe("applyGrokSubagentUpdate", () => {
  it("maps spawn/progress/finish onto the shared child-task path", () => {
    const spawned = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: undefined,
      error: undefined,
      tokensUsed: undefined,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    expect(spawned.events).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: "child-1",
          description: "Search the codebase",
          title: "Search the codebase",
          taskType: "subagent",
          role: "explore",
          model: "grok-4.6",
          agentPath: "child-session",
          timelineBypass: true,
        },
      },
    ]);
    expect(spawned.events[0]?.payload.parentAgentId).toBeUndefined();

    const progressed = applyGrokSubagentUpdate(spawned.state, {
      kind: "progress",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: "running",
      error: undefined,
      tokensUsed: 80,
      durationMs: 200,
      turnCount: 1,
      toolCallCount: 2,
      lastToolName: "grep",
      output: undefined,
    });
    expect(progressed.events).toHaveLength(1);
    expect(progressed.events[0]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "child-1",
        status: "running",
        lastToolName: "grep",
        typedUsage: { totalTokens: 80, durationMs: 200, toolUses: 2 },
      },
    });

    const finished = applyGrokSubagentUpdate(progressed.state, {
      kind: "finished",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: "completed",
      error: undefined,
      tokensUsed: 120,
      durationMs: 400,
      turnCount: 2,
      toolCallCount: 4,
      lastToolName: undefined,
      output: "Found 3 call sites.",
    });
    expect(finished.events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: "child-1",
          description: "Search the codebase",
          title: "Search the codebase",
          taskType: "subagent",
          role: "explore",
          model: "grok-4.6",
          agentPath: "child-session",
          timelineBypass: true,
          status: "completed",
          summary: "Found 3 call sites.",
          typedUsage: { totalTokens: 120, durationMs: 400, toolUses: 4 },
        },
      },
    ]);
  });

  it("does not treat the parent ACP session as a workflow coordinator", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionId: "parent-session",
      parent_session_id: "parent-session",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        subagent_type: "explore",
      },
    });
    expect(parsed).toBeDefined();
    const applied = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), parsed!);
    expect(applied.events[0]?.payload.parentAgentId).toBeUndefined();
    expect(applied.events[0]?.payload.taskType).toBe("subagent");
  });

  it("completes a first-seen terminal subagent", () => {
    const applied = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "finished",
      subagentId: "late-1",
      childSessionId: undefined,
      role: "general-purpose",
      description: undefined,
      model: undefined,
      status: "failed",
      error: "cancelled by parent",
      tokensUsed: 9,
      durationMs: 30,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    expect(applied.events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(applied.events[1]?.payload).toMatchObject({
      taskId: "late-1",
      status: "failed",
      summary: "cancelled by parent",
    });
  });

  it("keeps spawn-time token count when a later tick only reports tools", () => {
    const spawned = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: undefined,
      role: "explore",
      description: undefined,
      model: undefined,
      status: undefined,
      error: undefined,
      tokensUsed: 50,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    const toolOnly = applyGrokSubagentUpdate(spawned.state, {
      kind: "progress",
      subagentId: "child-1",
      childSessionId: undefined,
      role: "explore",
      description: undefined,
      model: undefined,
      status: "running",
      error: undefined,
      tokensUsed: undefined,
      durationMs: 900,
      turnCount: undefined,
      toolCallCount: 7,
      lastToolName: "bash",
      output: undefined,
    });
    expect(toolOnly.events[0]?.payload.typedUsage).toEqual({
      totalTokens: 50,
      durationMs: 900,
      toolUses: 7,
    });
  });
});

describe("parseXAiWorkflowUpdated", () => {
  it("reads a workflow_updated envelope", () => {
    const parsed = parseXAiWorkflowUpdated({
      update: {
        sessionUpdate: "workflow_updated",
        run_id: "run-1",
        name: "review",
        objective: "Review the PR",
        status: "active",
        current_phase: "review",
        phases: [{ title: "review", state: "running" }],
        agents: [
          {
            agent_id: "agent-a",
            label: "Reviewer",
            phase: "review",
            model: "grok-4.6",
            state: "running",
            tokens_used: 20,
            duration_ms: 100,
          },
        ],
      },
    });
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.agents).toHaveLength(1);
    expect(parsed?.agents[0]?.agentId).toBe("agent-a");
  });
});

describe("applyGrokWorkflowUpdate", () => {
  it("stamps members with parentAgentId, timelineBypass, and a stable slot", () => {
    const applied = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [{ title: "review", state: "running" }],
      currentPhase: "review",
      agentBudget: 4,
      agentsUsed: 1,
      elapsedMs: 100,
      activeAgents: 1,
      currentAgentLabel: "Reviewer",
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: "review",
          model: "grok-4.6",
          state: "running",
          tokensUsed: 20,
          durationMs: 100,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });

    expect(applied.events[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "run-1",
        taskType: "local_workflow",
        workflowName: "review",
      },
    });
    const memberStart = applied.events.find(
      (event) =>
        event.type === "task.started" &&
        event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
    );
    expect(memberStart?.payload).toMatchObject({
      parentAgentId: "run-1",
      timelineBypass: true,
      taskType: "subagent",
      title: "Reviewer",
      model: "grok-4.6",
    });
  });

  it("skips unchanged member ticks", () => {
    const first = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: undefined,
          model: undefined,
          state: "running",
          tokensUsed: 10,
          durationMs: 50,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const second = applyGrokWorkflowUpdate(first.state, {
      runId: "run-1",
      revision: 2,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: undefined,
          model: undefined,
          state: "running",
          tokensUsed: 10,
          durationMs: 50,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    expect(
      second.events.filter(
        (event) => event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
      ),
    ).toHaveLength(0);
  });

  it("emits member progress when wire state changes but mapped status does not", () => {
    const member = {
      agentId: "agent-a",
      label: "Reviewer",
      phase: undefined as string | undefined,
      model: undefined as string | undefined,
      tokensUsed: 10,
      durationMs: 50,
    };
    const first = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [{ ...member, state: "start" }],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const second = applyGrokWorkflowUpdate(first.state, {
      runId: "run-1",
      revision: 2,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [{ ...member, state: "running" }],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const memberProgress = second.events.find(
      (event) =>
        event.type === "task.progress" &&
        event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
    );
    expect(memberProgress?.payload).toMatchObject({
      status: "running",
      summary: "running",
    });
  });
});

describe("Grok notification continuity", () => {
  it("omits absent metadata from sparse progress and completion", () => {
    const spawn = parseXAiSubagentUpdate({
      sessionUpdate: "subagent_spawned",
      subagent_id: "child",
      description: "Search the codebase",
      role: "explore",
      model: "grok-4.6",
      child_session_id: "session",
    })!;
    let state = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), spawn).state;
    for (const sessionUpdate of ["subagent_progress", "subagent_finished"]) {
      const next = applyGrokSubagentUpdate(
        state,
        parseXAiSubagentUpdate({ sessionUpdate, subagent_id: "child", tokens_used: 10 })!,
      );
      expect(next.events).toHaveLength(1);
      expect(() =>
        decodeRuntimeEvent({
          ...next.events[0],
          eventId: "event",
          createdAt: "2026-09-07T00:00:00.000Z",
          provider: "grok",
          threadId: "thread",
        }),
      ).not.toThrow();
      if (sessionUpdate === "subagent_progress") {
        expect(next.events[0]?.payload.description).toBe("Search the codebase");
      }
      for (const field of ["title", "role", "model", "agentPath"]) {
        expect(next.events[0]?.payload).not.toHaveProperty(field);
      }
      state = next.state;
    }
  });

  it("ignores stale and repeated workflow revisions", () => {
    const update = parseXAiWorkflowUpdated({
      sessionUpdate: "workflow_updated",
      run_id: "run",
      name: "review",
      revision: 3,
      agents: [{ agent_id: "a", state: "done" }],
    })!;
    const completed = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), update);
    for (const revision of [2, 3]) {
      const stale = applyGrokWorkflowUpdate(completed.state, {
        ...update,
        revision,
        agents: update.agents.map((agent) => ({ ...agent, state: "running" })),
      });
      expect(stale.events).toEqual([]);
    }
  });

  it("accepts unversioned updates and treats revision zero as ordered", () => {
    const update = parseXAiWorkflowUpdated({
      sessionUpdate: "workflow_updated",
      run_id: "run",
      name: "review",
    })!;
    const first = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), update);
    expect(applyGrokWorkflowUpdate(first.state, update).events).toHaveLength(1);
    const zero = applyGrokWorkflowUpdate(first.state, { ...update, revision: 0 });
    expect(applyGrokWorkflowUpdate(zero.state, { ...update, revision: 0 }).events).toEqual([]);
    expect(
      applyGrokWorkflowUpdate(zero.state, { ...update, runId: "other", revision: 0 }).events,
    ).toHaveLength(1);
  });

  it("does not reactivate finished members in newer snapshots", () => {
    const update = parseXAiWorkflowUpdated({
      sessionUpdate: "workflow_updated",
      run_id: "run",
      name: "review",
      revision: 3,
      agents: [{ agent_id: "a", state: "done" }],
    })!;
    const completed = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), update);
    const next = applyGrokWorkflowUpdate(completed.state, {
      ...update,
      revision: 4,
      agents: update.agents.map((agent) => ({ ...agent, state: "running" })),
    });
    expect(next.events.filter((event) => event.payload.taskId === "run:wf:a")).toEqual([]);
  });
});

describe("Grok session tracking retention", () => {
  it("retains active usage and reuses session collections across historical completions", () => {
    const state = emptyGrokSubagentTrackState();
    const active = parseXAiSubagentUpdate({
      sessionUpdate: "subagent_progress",
      subagent_id: "active",
      tokens_used: 42,
    })!;
    applyGrokSubagentUpdate(state, active);
    for (let index = 0; index < 1000; index++) {
      const next = applyGrokSubagentUpdate(state, {
        ...active,
        kind: "finished",
        subagentId: `finished-${index}`,
      });
      expect(next.state).toBe(state);
    }
    expect(state.usageByTaskId.size).toBe(1);
    expect(state.subagentDescriptions.size).toBe(1);
    const progressed = applyGrokSubagentUpdate(state, {
      ...active,
      tokensUsed: undefined,
      toolCallCount: 3,
    });
    expect(progressed.events[0]?.payload.typedUsage).toEqual({ totalTokens: 42, toolUses: 3 });
  });

  it("releases terminal subagent payload while suppressing late events", () => {
    const update = parseXAiSubagentUpdate({
      sessionUpdate: "subagent_finished",
      subagent_id: "child",
      tokens_used: 25,
    })!;
    const completed = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), update);
    expect(completed.state.usageByTaskId.size).toBe(0);
    expect(completed.state.subagentDescriptions.size).toBe(0);
    for (const kind of ["spawned", "progress", "finished"] as const) {
      expect(applyGrokSubagentUpdate(completed.state, { ...update, kind }).events).toEqual([]);
    }
  });

  it("releases completed member payload without losing deduplication", () => {
    const update = parseXAiWorkflowUpdated({
      sessionUpdate: "workflow_updated",
      run_id: "run",
      name: "review",
      agents: [{ agent_id: "a", state: "done", tokens_used: 25 }],
    })!;
    const completed = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), update);
    expect(completed.state.usageByTaskId.size).toBe(0);
    expect(completed.state.memberFingerprints.size).toBe(0);
    expect(completed.state.memberRunIds.size).toBe(0);
    const late = applyGrokWorkflowUpdate(completed.state, {
      ...update,
      agents: update.agents.map((agent) => ({ ...agent, tokensUsed: 30 })),
    });
    expect(late.events.filter((event) => event.payload.taskId === "run:wf:a")).toEqual([]);
  });
});

describe("Grok terminal workflow ownership", () => {
  it("settles listed and omitted members before the run and rejects later snapshots", () => {
    const update = parseXAiWorkflowUpdated({
      sessionUpdate: "workflow_updated",
      run_id: "run",
      name: "review",
      agents: [
        { agent_id: "a", state: "running", tokens_used: 25 },
        { agent_id: "b", state: "running", tokens_used: 10 },
      ],
    })!;
    const state = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), update).state;
    const terminal = applyGrokWorkflowUpdate(state, {
      ...update,
      status: "complete",
      agents: [{ ...update.agents[0]!, tokensUsed: 50 }],
    });
    expect(
      terminal.events
        .filter((event) => event.type === "task.completed")
        .map((event) => [event.payload.taskId, event.payload.typedUsage]),
    ).toEqual([
      ["run:wf:a", { totalTokens: 50 }],
      ["run:wf:b", { totalTokens: 10 }],
      ["run", undefined],
    ]);
    for (const spec of terminal.events) {
      expect(() =>
        decodeRuntimeEvent({
          ...spec,
          eventId: "event",
          createdAt: "2026-09-07T00:00:00.000Z",
          provider: "grok",
          threadId: "thread",
        }),
      ).not.toThrow();
    }
    expect(state.usageByTaskId.size).toBe(0);
    expect(state.memberFingerprints.size).toBe(0);
    expect(
      applyGrokWorkflowUpdate(state, {
        ...update,
        revision: 100,
        agents: [{ ...update.agents[0]!, agentId: "new" }],
      }).events,
    ).toEqual([]);
  });
});
