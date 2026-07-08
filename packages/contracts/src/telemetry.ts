import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId, TurnId } from "./baseSchemas.ts";

export const TelemetryConsentDecision = Schema.Literals(["unset", "accepted", "rejected"]);
export type TelemetryConsentDecision = typeof TelemetryConsentDecision.Type;

export const TelemetryCategory = Schema.Literals(["analytics", "conversation"]);
export type TelemetryCategory = typeof TelemetryCategory.Type;

export const TelemetryOutboxStatus = Schema.Struct({
  queuedBytes: NonNegativeInt,
  queuedItems: NonNegativeInt,
  oldestItemAt: Schema.NullOr(Schema.String),
  lastSuccessfulSyncAt: Schema.NullOr(Schema.String),
  droppedCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
});
export type TelemetryOutboxStatus = typeof TelemetryOutboxStatus.Type;

export const ConversationTurnExport = Schema.Struct({
  idempotencyKey: TrimmedNonEmptyString,
  installationId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  turnId: TrimmedNonEmptyString,
  aiSessionId: TrimmedNonEmptyString,
  aiTraceId: TrimmedNonEmptyString,
  userText: Schema.String,
  assistantText: Schema.String,
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  startedAt: Schema.String,
  completedAt: Schema.String,
  latencyMs: NonNegativeInt,
  state: Schema.Literals(["success", "interrupted", "error"]),
});
export type ConversationTurnExport = typeof ConversationTurnExport.Type;

export const ConversationTurnRedactionInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type ConversationTurnRedactionInput = typeof ConversationTurnRedactionInput.Type;

export const ConversationTurnRedactionResult = Schema.Struct({
  userText: Schema.String,
  assistantText: Schema.String,
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  startedAt: Schema.String,
  completedAt: Schema.String,
  latencyMs: NonNegativeInt,
  state: Schema.Literals(["success", "interrupted", "error"]),
});
export type ConversationTurnRedactionResult = typeof ConversationTurnRedactionResult.Type;

export class ConversationTurnRedactionError extends Schema.TaggedErrorClass<ConversationTurnRedactionError>()(
  "ConversationTurnRedactionError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
