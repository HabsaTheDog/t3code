import { TelemetryOutbox } from "./outbox";
import { redactSensitiveText } from "./sanitize";
import type { ConversationTurnExport, TelemetryConsentDecision } from "./types";

export function conversationIdempotencyKey(threadId: string, turnId: string): string {
  return `conversation:${threadId}:${turnId}`;
}

export function buildConversationGenerationPayload(
  turn: ConversationTurnExport,
  configuredSecrets: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const provider = redactSensitiveText(turn.provider, configuredSecrets);
  const model = redactSensitiveText(turn.model, configuredSecrets);
  return {
    distinct_id: turn.installationId,
    $ai_session_id: turn.aiSessionId,
    $ai_trace_id: turn.aiTraceId,
    $ai_generation_id: turn.turnId,
    $ai_model: model,
    $ai_provider: provider,
    $ai_input: [
      {
        role: "user",
        content: redactSensitiveText(turn.userText, configuredSecrets),
      },
    ],
    $ai_output_choices: [
      {
        role: "assistant",
        content: redactSensitiveText(turn.assistantText, configuredSecrets),
      },
    ],
    $ai_latency: Math.max(0, turn.latencyMs) / 1_000,
    $ai_is_error: turn.state === "error",
    $ai_error: turn.state === "error" ? "Assistant turn failed." : undefined,
    state: turn.state,
    started_at: turn.startedAt,
    completed_at: turn.completedAt,
  };
}

export class ConversationExporter {
  constructor(
    private readonly outbox: TelemetryOutbox,
    private readonly options: {
      readonly consent: () => {
        readonly decision: TelemetryConsentDecision;
        readonly enabledAt: string | null;
      };
      readonly configuredSecrets?: () => ReadonlyArray<string>;
    },
  ) {}

  async exportCompletedTurn(turn: ConversationTurnExport): Promise<boolean> {
    const consent = this.options.consent();
    const enabledAt = consent.enabledAt === null ? Number.NaN : Date.parse(consent.enabledAt);
    const startedAt = Date.parse(turn.startedAt);
    const completedAt = Date.parse(turn.completedAt);
    if (
      consent.decision !== "accepted" ||
      !Number.isFinite(enabledAt) ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      startedAt < enabledAt
    ) {
      return false;
    }
    if (await this.outbox.hasConversationTurn(turn.threadId, turn.turnId)) {
      return false;
    }
    const result = await this.outbox.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      idempotencyKey: turn.idempotencyKey,
      payload: buildConversationGenerationPayload(turn, this.options.configuredSecrets?.() ?? []),
      createdAt: completedAt,
    });
    if (result === "dropped") return false;
    await this.outbox.markConversationTurn(turn.threadId, turn.turnId);
    return result === "enqueued";
  }
}
