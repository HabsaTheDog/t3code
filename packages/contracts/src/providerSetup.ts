import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MINIMUM_STUDY_BUDDY_CODEX_VERSION = "0.138.0";

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

export const ProviderSetupInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderSetupInput = typeof ProviderSetupInput.Type;

const SetupOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderAuthState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  flowId: Schema.NullOr(SetupOperationId),
  authorizationUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
});
export type ProviderAuthState = typeof ProviderAuthState.Type;

export const ProviderAuthCompleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderAuthCompleteInput = typeof ProviderAuthCompleteInput.Type;

export const ProviderAuthCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
});
export type ProviderAuthCancelInput = typeof ProviderAuthCancelInput.Type;

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProviderInstallState = Schema.Struct({
  driver: ProviderDriverKind,
  operationId: Schema.NullOr(SetupOperationId),
  phase: Schema.Literals([
    "idle",
    "downloading",
    "extracting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ProviderInstallState = typeof ProviderInstallState.Type;

export const ProviderInstallCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: SetupOperationId,
});
export type ProviderInstallCancelInput = typeof ProviderInstallCancelInput.Type;

/** Safe setup failure text. Never include OAuth codes, URLs, or native token data. */
export class ProviderInstanceSetupError extends Schema.TaggedErrorClass<ProviderInstanceSetupError>()(
  "ProviderInstanceSetupError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderManageInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: Schema.Literals([
    "status",
    "install",
    "install-cancel",
    "auth-start",
    "auth-complete",
    "auth-cancel",
    "logout",
    "refresh-models",
  ]),
  flowId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  callbackUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_384))),
  operationId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type ProviderManageInput = typeof ProviderManageInput.Type;
export const ProviderManageResult = Schema.Struct({
  install: ProviderInstallState,
  auth: ProviderAuthState,
});
export type ProviderManageResult = typeof ProviderManageResult.Type;
