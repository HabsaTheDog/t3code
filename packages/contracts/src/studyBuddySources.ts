import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const StableId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/));

export const StudyBuddySourceId = StableId;
export type StudyBuddySourceId = typeof StudyBuddySourceId.Type;
export const StudyBuddySourceConnectionId = StableId;
export type StudyBuddySourceConnectionId = typeof StudyBuddySourceConnectionId.Type;

export const StudyBuddySourceKind = Schema.Literals([
  "moodle-course",
  "calendar",
  "website",
  "resource-portal",
  "email",
]);
export type StudyBuddySourceKind = typeof StudyBuddySourceKind.Type;

export const StudyBuddySourceCapability = Schema.Literals([
  "content.search",
  "content.list",
  "content.read",
  "content.download",
  "calendar.events.read",
  "course.structure.read",
  "quiz.completed-attempt.read",
  "mail.threads.list",
  "mail.message.read",
  "mail.attachment.read",
  "mail.draft.local",
  "mail.draft.remote",
  "mail.send",
]);
export type StudyBuddySourceCapability = typeof StudyBuddySourceCapability.Type;

export const StudyBuddySourceAuthMode = Schema.Literals([
  "none",
  "password",
  "bearer-url",
  "interactive-session",
  "oauth",
]);
export type StudyBuddySourceAuthMode = typeof StudyBuddySourceAuthMode.Type;

export const StudyBuddySourceAuthStatus = Schema.Struct({
  mode: StudyBuddySourceAuthMode,
  state: Schema.Literals([
    "not-required",
    "not-configured",
    "configured",
    "expired",
    "action-required",
  ]),
  accountLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
  emailAddress: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(320), Schema.isPattern(/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/)),
  ),
});
export type StudyBuddySourceAuthStatus = typeof StudyBuddySourceAuthStatus.Type;

export const StudyBuddyEmailProviderHint = Schema.Literals([
  "auto-detect",
  "sogo",
  "roundcube",
  "microsoft-365",
  "google-workspace",
  "standard-imaps",
  "other-webmail",
]);
export type StudyBuddyEmailProviderHint = typeof StudyBuddyEmailProviderHint.Type;

export const StudyBuddyEmailProviderProfile = Schema.Struct({
  id: StableId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  discovery: Schema.Literals(["direct", "url-signature", "server-probe"]),
  transport: Schema.Literals(["imaps", "https-webmail"]),
  readStateGuarantee: Schema.Literals(["verified-peek", "unproven"]),
});
export type StudyBuddyEmailProviderProfile = typeof StudyBuddyEmailProviderProfile.Type;

export const StudyBuddySourceHealth = Schema.Struct({
  status: Schema.Literals(["unknown", "connected", "action-required", "expired", "failed"]),
  checkedAt: Schema.optionalKey(IsoDateTime),
  safeMessage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type StudyBuddySourceHealth = typeof StudyBuddySourceHealth.Type;

export const StudyBuddySourceScope = Schema.Struct({
  allowedOrigins: Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
  pathPrefixes: Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
  courseIds: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
    Schema.check(Schema.isMaxLength(128)),
  ),
  mailFolders: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
  tags: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
});
export type StudyBuddySourceScope = typeof StudyBuddySourceScope.Type;

export const StudyBuddySourcePolicy = Schema.Struct({
  authenticatedReads: Schema.Literals(["allowed", "approval-required", "denied"]),
  downloads: Schema.Literals(["allowed", "approval-required", "denied"]),
  remoteDrafts: Schema.Literals(["allowed", "approval-required", "denied"]),
  emailSend: Schema.Literals(["approval-required", "denied"]),
});
export type StudyBuddySourcePolicy = typeof StudyBuddySourcePolicy.Type;

export const StudyBuddySourceConnection = Schema.Struct({
  id: StudyBuddySourceConnectionId,
  adapterId: StableId,
  adapterVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  displayOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  entryPath: Schema.String.check(Schema.isMaxLength(2_000)),
  allowedOrigins: Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
  auth: StudyBuddySourceAuthStatus,
  emailProviderProfile: Schema.optionalKey(StudyBuddyEmailProviderProfile),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type StudyBuddySourceConnection = typeof StudyBuddySourceConnection.Type;

export const StudyBuddySourceBlock = Schema.Struct({
  id: StudyBuddySourceId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  kind: StudyBuddySourceKind,
  enabled: Schema.Boolean,
  connectionId: StudyBuddySourceConnectionId,
  parentSourceId: Schema.optionalKey(StudyBuddySourceId),
  priority: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(10_000),
  ),
  scope: StudyBuddySourceScope,
  capabilities: Schema.Array(StudyBuddySourceCapability).pipe(Schema.check(Schema.isMaxLength(32))),
  policy: StudyBuddySourcePolicy,
  health: StudyBuddySourceHealth,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type StudyBuddySourceBlock = typeof StudyBuddySourceBlock.Type;

export const StudyBuddySourceAdapterDescriptor = Schema.Struct({
  id: StableId,
  kind: StudyBuddySourceKind,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.String.check(Schema.isMaxLength(240)),
  supportedAuthModes: Schema.Array(StudyBuddySourceAuthMode),
  defaultCapabilities: Schema.Array(StudyBuddySourceCapability),
  availability: Schema.Literals(["available", "manual-action", "coming-soon"]),
});
export type StudyBuddySourceAdapterDescriptor = typeof StudyBuddySourceAdapterDescriptor.Type;

export const StudyBuddySourceInventory = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  adapters: Schema.Array(StudyBuddySourceAdapterDescriptor),
  connections: Schema.Array(StudyBuddySourceConnection),
  sources: Schema.Array(StudyBuddySourceBlock),
});
export type StudyBuddySourceInventory = typeof StudyBuddySourceInventory.Type;

export const StudyBuddyCreateSourceAuth = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("set-none") }),
  Schema.Struct({
    operation: Schema.Literal("set-password"),
    username: Schema.String.check(Schema.isMaxLength(1_000)),
    password: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
    emailAddress: Schema.optionalKey(
      Schema.String.check(
        Schema.isMaxLength(320),
        Schema.isPattern(/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/),
      ),
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("set-bearer-url"),
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  }),
]);
export type StudyBuddyCreateSourceAuth = typeof StudyBuddyCreateSourceAuth.Type;

export const StudyBuddyCreateSourceInput = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  kind: StudyBuddySourceKind,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  enabled: Schema.Boolean,
  emailProviderHint: Schema.optionalKey(StudyBuddyEmailProviderHint),
  auth: StudyBuddyCreateSourceAuth,
});
export type StudyBuddyCreateSourceInput = typeof StudyBuddyCreateSourceInput.Type;

export const StudyBuddyUpdateSourceInput = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sourceId: StudyBuddySourceId,
  label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
  enabled: Schema.optionalKey(Schema.Boolean),
  emailProviderHint: Schema.optionalKey(StudyBuddyEmailProviderHint),
});
export type StudyBuddyUpdateSourceInput = typeof StudyBuddyUpdateSourceInput.Type;

/**
 * Student-facing mail permissions. Sending is never an unconditional grant:
 * `send: true` only allows Study Buddy to create an exact-message approval
 * request that the user must approve once in the chat UI.
 */
export const StudyBuddyUpdateEmailPermissionsInput = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sourceId: StudyBuddySourceId,
  read: Schema.Boolean,
  draft: Schema.Boolean,
  send: Schema.Boolean,
  senderEmail: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(320), Schema.isPattern(/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/)),
  ),
});
export type StudyBuddyUpdateEmailPermissionsInput =
  typeof StudyBuddyUpdateEmailPermissionsInput.Type;

export const StudyBuddyDeleteSourceInput = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sourceId: StudyBuddySourceId,
});
export type StudyBuddyDeleteSourceInput = typeof StudyBuddyDeleteSourceInput.Type;

export const StudyBuddySetSourceAuthInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("set-password"),
    expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    sourceId: StudyBuddySourceId,
    username: Schema.String.check(Schema.isMaxLength(1_000)),
    password: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
    emailAddress: Schema.optionalKey(
      Schema.String.check(
        Schema.isMaxLength(320),
        Schema.isPattern(/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/),
      ),
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("set-bearer-url"),
    expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    sourceId: StudyBuddySourceId,
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("clear"),
    expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    sourceId: StudyBuddySourceId,
  }),
]);
export type StudyBuddySetSourceAuthInput = typeof StudyBuddySetSourceAuthInput.Type;

export const StudyBuddyTestSourceInput = Schema.Struct({ sourceId: StudyBuddySourceId });
export type StudyBuddyTestSourceInput = typeof StudyBuddyTestSourceInput.Type;

/**
 * Opaque, stable identifier assigned by the email adapter. Callers must never
 * attempt to reconstruct a provider URL or IMAP UID from this value.
 */
export const StudyBuddyEmailMessageId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type StudyBuddyEmailMessageId = typeof StudyBuddyEmailMessageId.Type;

export const StudyBuddyEmailFolder = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type StudyBuddyEmailFolder = typeof StudyBuddyEmailFolder.Type;

export const StudyBuddyEmailAddress = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
  address: TrimmedNonEmptyString.check(Schema.isMaxLength(320)),
});
export type StudyBuddyEmailAddress = typeof StudyBuddyEmailAddress.Type;

export const StudyBuddyEmailMessageSummary = Schema.Struct({
  messageId: StudyBuddyEmailMessageId,
  threadId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  folder: StudyBuddyEmailFolder,
  subject: Schema.String.check(Schema.isMaxLength(2_000)),
  from: Schema.Array(StudyBuddyEmailAddress).pipe(Schema.check(Schema.isMaxLength(128))),
  to: Schema.Array(StudyBuddyEmailAddress).pipe(Schema.check(Schema.isMaxLength(512))),
  sentAt: Schema.optionalKey(IsoDateTime),
  receivedAt: Schema.optionalKey(IsoDateTime),
  sanitizedPreview: Schema.String.check(Schema.isMaxLength(4_000)),
  isSeen: Schema.Boolean,
  hasAttachments: Schema.Boolean,
});
export type StudyBuddyEmailMessageSummary = typeof StudyBuddyEmailMessageSummary.Type;

const StudyBuddyEmailPageFields = {
  sourceId: StudyBuddySourceId,
  folder: Schema.optionalKey(StudyBuddyEmailFolder),
  cursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
};

export const StudyBuddyListEmailMessagesInput = Schema.Struct({
  ...StudyBuddyEmailPageFields,
  unreadOnly: Schema.optionalKey(Schema.Boolean),
});
export type StudyBuddyListEmailMessagesInput = typeof StudyBuddyListEmailMessagesInput.Type;

export const StudyBuddySearchEmailMessagesInput = Schema.Struct({
  ...StudyBuddyEmailPageFields,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type StudyBuddySearchEmailMessagesInput = typeof StudyBuddySearchEmailMessagesInput.Type;

export const StudyBuddyEmailMessagePage = Schema.Struct({
  sourceId: StudyBuddySourceId,
  messages: Schema.Array(StudyBuddyEmailMessageSummary).pipe(Schema.check(Schema.isMaxLength(100))),
  nextCursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type StudyBuddyEmailMessagePage = typeof StudyBuddyEmailMessagePage.Type;

export const StudyBuddyReadEmailMessageInput = Schema.Struct({
  sourceId: StudyBuddySourceId,
  folder: StudyBuddyEmailFolder,
  messageId: StudyBuddyEmailMessageId,
});
export type StudyBuddyReadEmailMessageInput = typeof StudyBuddyReadEmailMessageInput.Type;

/** Only sanitized, display-safe representations cross the source broker boundary. */
export const StudyBuddyEmailSanitizedBody = Schema.Struct({
  sanitizedText: Schema.String.check(Schema.isMaxLength(5_000_000)),
  sanitizedHtml: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(5_000_000))),
  truncated: Schema.Boolean,
});
export type StudyBuddyEmailSanitizedBody = typeof StudyBuddyEmailSanitizedBody.Type;

/**
 * Proves that fetching message content did not change the user's unread state.
 * Email adapters must use a non-mutating provider API (for IMAP, BODY.PEEK).
 */
export const StudyBuddyEmailSeenState = Schema.Struct({
  seenBefore: Schema.Boolean,
  seenAfter: Schema.Boolean,
  preserved: Schema.Boolean,
});
export type StudyBuddyEmailSeenState = typeof StudyBuddyEmailSeenState.Type;

export const StudyBuddyReadEmailMessageResult = Schema.Struct({
  sourceId: StudyBuddySourceId,
  message: StudyBuddyEmailMessageSummary,
  cc: Schema.Array(StudyBuddyEmailAddress).pipe(Schema.check(Schema.isMaxLength(512))),
  replyTo: Schema.Array(StudyBuddyEmailAddress).pipe(Schema.check(Schema.isMaxLength(128))),
  body: StudyBuddyEmailSanitizedBody,
  seenState: StudyBuddyEmailSeenState,
});
export type StudyBuddyReadEmailMessageResult = typeof StudyBuddyReadEmailMessageResult.Type;

const EmailHeaderText = Schema.String.check(
  Schema.isMaxLength(2_000),
  Schema.isPattern(/^[^\r\n]*$/),
);

export const StudyBuddyEmailApprovalAddress = Schema.Struct({
  name: Schema.optionalKey(EmailHeaderText),
  address: TrimmedNonEmptyString.check(
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/),
  ),
});
export type StudyBuddyEmailApprovalAddress = typeof StudyBuddyEmailApprovalAddress.Type;

export const StudyBuddyEmailSendApprovalPayload = Schema.Struct({
  version: Schema.Literal(1),
  owner: Schema.Literal("study-buddy"),
  action: Schema.Literal("send_email"),
  sourceId: StudyBuddySourceId,
  from: StudyBuddyEmailApprovalAddress,
  to: Schema.Array(StudyBuddyEmailApprovalAddress).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  cc: Schema.Array(StudyBuddyEmailApprovalAddress).pipe(Schema.check(Schema.isMaxLength(100))),
  bcc: Schema.Array(StudyBuddyEmailApprovalAddress).pipe(Schema.check(Schema.isMaxLength(100))),
  subject: EmailHeaderText,
  bodyText: Schema.String.check(Schema.isMaxLength(100_000)),
  /** Attachments remain empty until the broker has an opaque attachment store. */
  attachments: Schema.Array(
    Schema.Struct({
      id: StableId,
      name: EmailHeaderText,
      sizeBytes: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(25 * 1024 * 1024),
      ),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(20))),
  expiresAt: IsoDateTime,
});
export type StudyBuddyEmailSendApprovalPayload = typeof StudyBuddyEmailSendApprovalPayload.Type;

export const StudyBuddySourceTestResult = Schema.Struct({
  sourceId: StudyBuddySourceId,
  status: Schema.Literals(["success", "failure", "action-required", "unsupported"]),
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  checkedAt: IsoDateTime,
});
export type StudyBuddySourceTestResult = typeof StudyBuddySourceTestResult.Type;

export class StudyBuddySourceError extends Schema.TaggedErrorClass<StudyBuddySourceError>()(
  "StudyBuddySourceError",
  {
    code: Schema.Literals(["invalid", "not-found", "conflict", "unavailable", "internal"]),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  },
) {}
