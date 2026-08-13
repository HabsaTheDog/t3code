import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import {
  ConversationExporter,
  buildConversationGenerationPayload,
  extractGeneratedArtifacts,
} from "./conversation";
import { TelemetryOutbox } from "./outbox";
import { MAX_RESPONSE_FEEDBACK_LENGTH, type ConversationTurnExport } from "./types";

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

  it("extracts local generated artifacts without treating web links as files", () => {
    expect(
      extractGeneratedArtifacts(
        "Open [study-guide.pdf](/tmp/study-guide.pdf) or [documentation](https://example.com/a.pdf).",
      ),
    ).toEqual([{ name: "study-guide.pdf", extension: "pdf" }]);
  });

  it("exports redacted logs, file evidence, and generated artifacts with trace linkage", async () => {
    const queue = outbox();
    const exporter = new ConversationExporter(queue, {
      consent: () => ({
        decision: "accepted",
        enabledAt: "2026-06-27T09:59:00.000Z",
      }),
      configuredSecrets: () => ["arbitrary-secret"],
    });
    await exporter.exportCompletedTurn({
      ...turn,
      assistantText: "Created [study-guide.pdf](/tmp/study-guide.pdf)",
      runLogs: [
        {
          kind: "runtime.error",
          tone: "error",
          summary: "Failed with arbitrary-secret",
          createdAt: turn.completedAt,
        },
      ],
      files: [
        {
          name: "study-guide.pdf",
          relativePath: "reports/study-guide.pdf",
          kind: "added",
          additions: 12,
          deletions: 0,
        },
      ],
    });

    const items = await queue.listDue();
    expect(items.map(({ event }) => event)).toEqual([
      "$ai_generation",
      "run.log.recorded",
      "run.file.changed",
      "artifact.generated",
    ]);
    expect(items[1]?.payload).toMatchObject({
      $ai_trace_id: "turn",
      run_log_summary: "Failed with [REDACTED_CONFIGURED_SECRET]",
      is_error: true,
    });
    expect(items[2]?.payload).toMatchObject({
      file_name: "study-guide.pdf",
      relative_file: "reports/study-guide.pdf",
      file_extension: "pdf",
    });
  });

  it("exports a redacted optional feedback note linked to its generation", async () => {
    const queue = outbox();
    const exporter = new ConversationExporter(queue, {
      consent: () => ({ decision: "accepted", enabledAt: turn.startedAt }),
      configuredSecrets: () => ["arbitrary-secret"],
    });
    await expect(
      exporter.exportResponseFeedback({
        installationId: "install",
        idempotencyKey: "feedback-1",
        threadId: "thread",
        turnId: "turn",
        rating: "negative",
        note: "It exposed arbitrary-secret",
      }),
    ).resolves.toBe(true);
    const [item] = await queue.listDue();
    expect(item).toMatchObject({
      event: "response.feedback.commented",
      payload: {
        $ai_session_id: "thread",
        $ai_trace_id: "turn",
        feedback_rating: "negative",
        feedback_note: "It exposed [REDACTED_CONFIGURED_SECRET]",
      },
    });
  });

  it("keeps long feedback while enforcing the shared upper bound", async () => {
    const queue = outbox();
    const exporter = new ConversationExporter(queue, {
      consent: () => ({ decision: "accepted", enabledAt: turn.startedAt }),
    });
    await exporter.exportResponseFeedback({
      installationId: "install",
      idempotencyKey: "feedback-long",
      threadId: "thread",
      turnId: "turn",
      rating: "positive",
      note: "x".repeat(MAX_RESPONSE_FEEDBACK_LENGTH + 100),
    });
    const [item] = await queue.listDue();
    expect(item?.payload.feedback_note).toHaveLength(MAX_RESPONSE_FEEDBACK_LENGTH);
    expect(item?.payload.feedback_note_length).toBe(MAX_RESPONSE_FEEDBACK_LENGTH);
  });
});
