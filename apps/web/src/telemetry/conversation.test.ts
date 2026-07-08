import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import { ConversationExporter, buildConversationGenerationPayload } from "./conversation";
import { TelemetryOutbox } from "./outbox";
import type { ConversationTurnExport } from "./types";

const turn: ConversationTurnExport = {
  idempotencyKey: "conversation:thread:turn",
  installationId: "install",
  threadId: "thread",
  turnId: "turn",
  aiSessionId: "thread",
  aiTraceId: "turn",
  userText: "Use token sk-proj-abcdefghijklmnopqrstuvwxyz",
  assistantText: "Done without exposing sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  provider: "codex",
  model: "gpt-5",
  startedAt: "2026-06-27T10:00:00.000Z",
  completedAt: "2026-06-27T10:00:01.000Z",
  latencyMs: 1_000,
  state: "success",
};

function outbox() {
  let id = 0;
  return new TelemetryOutbox({
    indexedDB: new IDBFactory(),
    databaseName: `conversation-test-${Math.random()}`,
    clock: { now: () => Date.parse(turn.completedAt) },
    random: { uuid: () => `id-${++id}`, unit: () => 0.5 },
  });
}

describe("ConversationExporter", () => {
  it("exports one user/assistant-only generation exactly once", async () => {
    const queue = outbox();
    const exporter = new ConversationExporter(queue, {
      consent: () => ({
        decision: "accepted",
        enabledAt: "2026-06-27T09:59:00.000Z",
      }),
    });
    await expect(exporter.exportCompletedTurn(turn)).resolves.toBe(true);
    await expect(exporter.exportCompletedTurn(turn)).resolves.toBe(false);
    const [item] = await queue.listDue();
    expect(item?.event).toBe("$ai_generation");
    expect(item?.payload).not.toHaveProperty("tools");
    expect(JSON.stringify(item?.payload)).not.toContain("sk-proj-");
    expect(JSON.stringify(item?.payload)).not.toContain("sk-ant-");
  });

  it("does not backfill turns started before consent", async () => {
    const exporter = new ConversationExporter(outbox(), {
      consent: () => ({
        decision: "accepted",
        enabledAt: "2026-06-27T10:00:00.500Z",
      }),
    });
    await expect(exporter.exportCompletedTurn(turn)).resolves.toBe(false);
  });

  it("emits the PostHog AI trace/session identifiers", () => {
    expect(buildConversationGenerationPayload(turn)).toMatchObject({
      $ai_session_id: "thread",
      $ai_trace_id: "turn",
      $ai_generation_id: "turn",
      $ai_model: "gpt-5",
      $ai_provider: "codex",
    });
  });

  it("redacts provider and custom model metadata", () => {
    expect(
      buildConversationGenerationPayload({
        ...turn,
        provider: "custom /home/alice/provider",
        model: "https://models.example/private?token=secret",
      }),
    ).toMatchObject({
      $ai_provider: "custom [REDACTED_PATH]",
      $ai_model: "[REDACTED_URL]",
    });
  });
});
