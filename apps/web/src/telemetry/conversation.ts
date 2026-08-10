import { TelemetryOutbox } from "./outbox";
import { redactSensitiveText } from "./sanitize";
import { MAX_RESPONSE_FEEDBACK_LENGTH } from "./types";
import type {
  ConversationTurnExport,
  ResponseFeedbackInput,
  TelemetryConsentDecision,
} from "./types";

const MAX_DIAGNOSTIC_TEXT_LENGTH = 1_000;
const MARKDOWN_FILE_LINK = /\[([^\]]+)\]\(([^)]+)\)/gu;

export interface GeneratedArtifactMetadata {
  readonly name: string;
  readonly extension: string;
}

export interface ResponseFeedbackExport extends ResponseFeedbackInput {
  readonly installationId: string;
  readonly idempotencyKey: string;
  readonly note: string;
}

export function conversationIdempotencyKey(threadId: string, turnId: string): string {
  return `conversation:${threadId}:${turnId}`;
}

export function buildConversationGenerationPayload(
  turn: ConversationTurnExport,
  configuredSecrets: ReadonlyArray<string> = [],
  contextProperties: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const provider = redactSensitiveText(turn.provider, configuredSecrets);
  const model = redactSensitiveText(turn.model, configuredSecrets);
  return {
    ...contextProperties,
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
    run_log_count: turn.runLogs?.length ?? 0,
    file_count: turn.files?.length ?? 0,
    artifact_count: extractGeneratedArtifacts(turn.assistantText).length,
  };
}

export function extractGeneratedArtifacts(text: string): ReadonlyArray<GeneratedArtifactMetadata> {
  const artifacts = new Map<string, GeneratedArtifactMetadata>();
  for (const match of text.matchAll(MARKDOWN_FILE_LINK)) {
    const label = match[1]?.trim();
    const target = match[2]?.trim().replace(/^<|>$/gu, "");
    if (!label || !target || /^(?:https?|mailto):/iu.test(target)) continue;
    const targetWithoutFragment = target.split(/[?#]/u, 1)[0] ?? target;
    const targetName = targetWithoutFragment.replaceAll("\\", "/").split("/").at(-1) ?? "";
    const displayName = label.includes(".") ? label : targetName;
    const extensionMatch = displayName.match(/\.([a-z0-9]{1,12})$/iu);
    if (!extensionMatch) continue;
    const name = displayName.slice(0, 240);
    artifacts.set(name.toLowerCase(), {
      name,
      extension: extensionMatch[1]!.toLowerCase(),
    });
  }
  return [...artifacts.values()];
}

function sharedTraceProperties(
  turn: ConversationTurnExport,
  contextProperties: Readonly<Record<string, unknown>>,
) {
  return {
    ...contextProperties,
    distinct_id: turn.installationId,
    $ai_session_id: turn.aiSessionId,
    $ai_trace_id: turn.aiTraceId,
    $ai_generation_id: turn.turnId,
    $ai_model: turn.model,
    $ai_provider: turn.provider,
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
      readonly contextProperties?: () => Readonly<Record<string, unknown>>;
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
      payload: buildConversationGenerationPayload(
        turn,
        this.options.configuredSecrets?.() ?? [],
        this.options.contextProperties?.() ?? {},
      ),
      createdAt: completedAt,
    });
    if (result === "dropped") return false;

    const configuredSecrets = this.options.configuredSecrets?.() ?? [];
    const contextProperties = this.options.contextProperties?.() ?? {};
    for (const [index, log] of (turn.runLogs ?? []).entries()) {
      await this.outbox.enqueue({
        category: "conversation",
        kind: "conversation",
        event: "run.log.recorded",
        idempotencyKey: `run.log.recorded:${turn.threadId}:${turn.turnId}:${index}`,
        payload: {
          ...sharedTraceProperties(turn, contextProperties),
          run_log_kind: redactSensitiveText(log.kind, configuredSecrets).slice(
            0,
            MAX_DIAGNOSTIC_TEXT_LENGTH,
          ),
          run_log_tone: log.tone,
          run_log_summary: redactSensitiveText(log.summary, configuredSecrets).slice(
            0,
            MAX_DIAGNOSTIC_TEXT_LENGTH,
          ),
          is_error:
            log.tone === "error" || log.kind === "runtime.error" || log.kind.endsWith(".failed"),
        },
        createdAt: Date.parse(log.createdAt),
      });
    }
    for (const [index, file] of (turn.files ?? []).entries()) {
      const extension = file.name.match(/\.([a-z0-9]{1,12})$/iu)?.[1]?.toLowerCase() ?? "none";
      await this.outbox.enqueue({
        category: "conversation",
        kind: "conversation",
        event: "run.file.changed",
        idempotencyKey: `run.file.changed:${turn.threadId}:${turn.turnId}:${index}`,
        payload: {
          ...sharedTraceProperties(turn, contextProperties),
          file_name: redactSensitiveText(file.name, configuredSecrets).slice(0, 240),
          relative_file: redactSensitiveText(file.relativePath, configuredSecrets).slice(0, 500),
          file_extension: extension,
          file_change_kind: file.kind ?? "unknown",
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        },
        createdAt: completedAt,
      });
    }
    for (const [index, artifact] of extractGeneratedArtifacts(turn.assistantText).entries()) {
      await this.outbox.enqueue({
        category: "conversation",
        kind: "conversation",
        event: "artifact.generated",
        idempotencyKey: `artifact.generated:${turn.threadId}:${turn.turnId}:${index}`,
        payload: {
          ...sharedTraceProperties(turn, contextProperties),
          artifact_name: redactSensitiveText(artifact.name, configuredSecrets).slice(0, 240),
          artifact_extension: artifact.extension,
        },
        createdAt: completedAt,
      });
    }
    await this.outbox.markConversationTurn(turn.threadId, turn.turnId);
    return result === "enqueued";
  }

  async exportResponseFeedback(feedback: ResponseFeedbackExport): Promise<boolean> {
    if (this.options.consent().decision !== "accepted") return false;
    const note = redactSensitiveText(feedback.note, this.options.configuredSecrets?.() ?? []).slice(
      0,
      MAX_RESPONSE_FEEDBACK_LENGTH,
    );
    if (!note.trim()) return false;
    const result = await this.outbox.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "response.feedback.commented",
      idempotencyKey: feedback.idempotencyKey,
      payload: {
        ...this.options.contextProperties?.(),
        distinct_id: feedback.installationId,
        $ai_session_id: feedback.threadId,
        $ai_trace_id: feedback.turnId,
        $ai_generation_id: feedback.turnId,
        feedback_rating: feedback.rating,
        feedback_note: note,
        feedback_note_length: note.length,
      },
    });
    return result === "enqueued";
  }
}
