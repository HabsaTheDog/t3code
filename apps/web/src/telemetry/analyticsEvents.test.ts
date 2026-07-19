import type { EventId, OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadAnalyticsEvents } from "./analyticsEvents";

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;

function activity(
  id: string,
  kind: "task.started" | "task.completed",
  createdAt: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: id as EventId,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId,
    createdAt,
  };
}

describe("buildThreadAnalyticsEvents", () => {
  it("emits content-free model, latency, parallelism, and token properties", () => {
    const events = buildThreadAnalyticsEvents({
      threadId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      provider: ProviderDriverKind.make("codex"),
      executionProfile: "quality",
      turn: {
        turnId,
        state: "completed",
        requestedAt: "2026-07-14T10:00:00.000Z",
        startedAt: "2026-07-14T10:00:01.000Z",
        completedAt: "2026-07-14T10:00:11.000Z",
        assistantMessageId: null,
      },
      activities: [
        activity("start-1", "task.started", "2026-07-14T10:00:02.000Z", {
          taskId: "worker-1",
          taskType: "codex-collab",
        }),
        activity("start-2", "task.started", "2026-07-14T10:00:03.000Z", {
          taskId: "worker-2",
          taskType: "visual",
        }),
        activity("done-1", "task.completed", "2026-07-14T10:00:08.000Z", {
          taskId: "worker-1",
          status: "completed",
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
        activity("done-2", "task.completed", "2026-07-14T10:00:09.000Z", {
          taskId: "worker-2",
          status: "failed",
          usage: { inputTokens: 50, reasoningOutputTokens: 7 },
        }),
      ],
    });

    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      event: "turn.completed",
      properties: {
        model: "gpt-5.6-terra",
        execution_profile: "quality",
        reasoning_effort: "medium",
        provider: "codex",
        duration_ms: 10_000,
        task_count: 2,
        max_parallel_tasks: 2,
        tokens_in: 150,
        tokens_out: 20,
        tokens_reasoning: 7,
      },
    });
    expect(JSON.stringify(events)).not.toContain("worker prompt");
  });

  it("deduplicates repeated terminal notifications for the same task", () => {
    const events = buildThreadAnalyticsEvents({
      threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      executionProfile: "fast",
      turn: {
        turnId,
        state: "completed",
        requestedAt: "2026-07-14T10:00:00.000Z",
        startedAt: "2026-07-14T10:00:00.000Z",
        completedAt: "2026-07-14T10:00:05.000Z",
        assistantMessageId: null,
      },
      activities: [
        activity("start", "task.started", "2026-07-14T10:00:01.000Z", {
          taskId: "worker-1",
        }),
        activity("done", "task.completed", "2026-07-14T10:00:03.000Z", {
          taskId: "worker-1",
          status: "completed",
        }),
        activity("done-again", "task.completed", "2026-07-14T10:00:04.000Z", {
          taskId: "worker-1",
          status: "completed",
        }),
      ],
    });

    expect(events.filter(({ event }) => event === "orchestration.task.completed")).toHaveLength(1);
  });

  it("never exports arbitrary task-type or reasoning strings", () => {
    const events = buildThreadAnalyticsEvents({
      threadId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "user course secret" }],
      },
      executionProfile: "balanced",
      turn: {
        turnId,
        state: "completed",
        requestedAt: "2026-07-14T10:00:00.000Z",
        startedAt: "2026-07-14T10:00:00.000Z",
        completedAt: "2026-07-14T10:00:05.000Z",
        assistantMessageId: null,
      },
      activities: [
        activity("start", "task.started", "2026-07-14T10:00:01.000Z", {
          taskId: "worker-1",
          taskType: "private course name",
        }),
        activity("done", "task.completed", "2026-07-14T10:00:03.000Z", {
          taskId: "worker-1",
          status: "completed",
        }),
      ],
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private course name");
    expect(serialized).not.toContain("user course secret");
    expect(events[0]?.properties).toMatchObject({ task_type: "unknown" });
  });
});
