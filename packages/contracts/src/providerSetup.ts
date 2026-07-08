import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderSetupProvider = Schema.Literals(["codex", "claude", "cursor", "opencode"]);
export type ProviderSetupProvider = typeof ProviderSetupProvider.Type;

export const ProviderSetupActionId = Schema.Literals([
  "codex.install",
  "codex.auth.browser",
  "codex.auth.device-code",
  "codex.auth.api-key",
  "codex.auth.access-token",
  "claude.install",
  "claude.auth.login",
  "claude.auth.console",
  "claude.auth.api-key",
  "cursor.install",
  "cursor.auth.login",
  "opencode.install",
  "opencode.auth.login",
]);
export type ProviderSetupActionId = typeof ProviderSetupActionId.Type;

export const ProviderSetupAction = Schema.Struct({
  id: ProviderSetupActionId,
  kind: Schema.Literals(["install", "authenticate"]),
  label: TrimmedNonEmptyString,
  supported: Schema.Boolean,
  unsupportedReason: Schema.NullOr(TrimmedNonEmptyString),
  requiresConfirmation: Schema.Boolean,
  secretInput: Schema.NullOr(Schema.Literals(["api-key", "access-token"])),
  interaction: Schema.Literals(["background", "sanitized-terminal"]),
});
export type ProviderSetupAction = typeof ProviderSetupAction.Type;

export const ProviderSetupCapability = Schema.Struct({
  provider: ProviderSetupProvider,
  displayName: TrimmedNonEmptyString,
  executable: TrimmedNonEmptyString,
  actions: Schema.Array(ProviderSetupAction),
});
export type ProviderSetupCapability = typeof ProviderSetupCapability.Type;

export const ProviderSetupStartInput = Schema.Struct({
  actionId: ProviderSetupActionId,
  confirmed: Schema.optional(Schema.Boolean),
  secretValue: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type ProviderSetupStartInput = typeof ProviderSetupStartInput.Type;

export const ProviderSetupStartResult = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type ProviderSetupStartResult = typeof ProviderSetupStartResult.Type;

export const ProviderSetupCancelInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type ProviderSetupCancelInput = typeof ProviderSetupCancelInput.Type;

export const ProviderSetupCancelResult = Schema.Struct({
  canceled: Schema.Boolean,
});
export type ProviderSetupCancelResult = typeof ProviderSetupCancelResult.Type;

export const ProviderSetupWriteInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  input: Schema.String.check(Schema.isMaxLength(16_384)),
});
export type ProviderSetupWriteInput = typeof ProviderSetupWriteInput.Type;

export const ProviderSetupWriteResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type ProviderSetupWriteResult = typeof ProviderSetupWriteResult.Type;

export const ProviderSetupErrorCode = Schema.Literals([
  "unknown_action",
  "unsupported_action",
  "confirmation_required",
  "secret_required",
  "unexpected_secret",
  "job_not_found",
  "internal_error",
]);
export type ProviderSetupErrorCode = typeof ProviderSetupErrorCode.Type;

export class ProviderSetupError extends Schema.TaggedErrorClass<ProviderSetupError>()(
  "ProviderSetupError",
  {
    code: ProviderSetupErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}

const ProviderSetupJobEventBase = {
  jobId: TrimmedNonEmptyString,
  actionId: ProviderSetupActionId,
  provider: ProviderSetupProvider,
  timestamp: IsoDateTime,
} as const;

export const ProviderSetupJobEvent = Schema.Union([
  Schema.Struct({ ...ProviderSetupJobEventBase, type: Schema.Literal("started") }),
  Schema.Struct({
    ...ProviderSetupJobEventBase,
    type: Schema.Literal("progress"),
    stream: Schema.Literals(["stdout", "stderr", "system"]),
    text: Schema.String.check(Schema.isMaxLength(10_000)),
  }),
  Schema.Struct({
    ...ProviderSetupJobEventBase,
    type: Schema.Literal("completed"),
    exitCode: Schema.Literal(0),
  }),
  Schema.Struct({
    ...ProviderSetupJobEventBase,
    type: Schema.Literal("failed"),
    message: Schema.String.check(Schema.isMaxLength(10_000)),
    exitCode: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({ ...ProviderSetupJobEventBase, type: Schema.Literal("cancelled") }),
]);
export type ProviderSetupJobEvent = typeof ProviderSetupJobEvent.Type;
