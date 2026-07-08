import {
  DEFAULT_SERVER_SETTINGS,
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { redactConversationTurn } from "./ConversationRedaction.ts";

const now = "2026-06-28T08:00:00.000Z";
const turnId = TurnId.make("turn-1");

function thread(): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.make("assistant-final"),
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    proposedPlans: [],
    delegatedWork: [],
    activities: [],
    checkpoints: [],
    session: null,
    messages: [
      {
        id: MessageId.make("user"),
        role: "user",
        text: "password arbitrary-secret",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("assistant-commentary"),
        role: "assistant",
        text: "intermediate",
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("assistant-final"),
        role: "assistant",
        text: "final arbitrary-secret",
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

describe("conversation telemetry server redaction", () => {
  it("returns only the final user/assistant pair with configured secrets removed", () => {
    expect(
      redactConversationTurn({
        thread: thread(),
        turnId,
        studyConfiguration: {
          envPath: "/private/.env.local",
          exists: true,
          raw: "",
          values: { MOODLE_PASSWORD: "arbitrary-secret" },
        },
        serverSettings: DEFAULT_SERVER_SETTINGS,
        events: [],
      }),
    ).toEqual({
      userText: "password [REDACTED_CONFIGURED_SECRET]",
      assistantText: "final [REDACTED_CONFIGURED_SECRET]",
      provider: "codex",
      model: "gpt-5",
      startedAt: now,
      completedAt: now,
      latencyMs: 0,
      state: "success",
    });
  });

  it("does not return a running turn", () => {
    const running = thread();
    expect(
      redactConversationTurn({
        thread: { ...running, latestTurn: { ...running.latestTurn!, state: "running" } },
        turnId,
        studyConfiguration: { envPath: "", exists: false, raw: "", values: {} },
        serverSettings: DEFAULT_SERVER_SETTINGS,
        events: [],
      }),
    ).toBeNull();
  });

  it("uses authoritative historical turn state, timing, model, and provider", () => {
    const historical = thread();
    const completedAt = "2026-06-28T08:01:00.000Z";
    const startedAt = "2026-06-28T08:00:10.000Z";
    const events = [
      {
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: historical.id,
        type: "thread.turn-start-requested",
        payload: {
          threadId: historical.id,
          messageId: MessageId.make("user"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-sonnet",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      },
      {
        sequence: 2,
        aggregateKind: "thread",
        aggregateId: historical.id,
        type: "thread.session-set",
        payload: {
          threadId: historical.id,
          session: {
            threadId: historical.id,
            status: "running",
            providerName: "claude",
            providerInstanceId: ProviderInstanceId.make("claude"),
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      },
    ] as unknown as ReadonlyArray<OrchestrationEvent>;

    expect(
      redactConversationTurn({
        thread: {
          ...historical,
          latestTurn: null,
          checkpoints: [
            {
              turnId,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("checkpoint-1"),
              status: "missing",
              files: [],
              assistantMessageId: MessageId.make("assistant-final"),
              completedAt,
            },
          ],
        },
        turnId,
        studyConfiguration: { envPath: "", exists: false, raw: "", values: {} },
        serverSettings: DEFAULT_SERVER_SETTINGS,
        events,
      }),
    ).toMatchObject({
      provider: "claude",
      model: "claude-sonnet",
      startedAt,
      completedAt,
      latencyMs: 50_000,
      state: "interrupted",
    });
  });
});
