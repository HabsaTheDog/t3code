// @effect-diagnostics nodeBuiltinImport:off -- Hashing binds approval to exact content.
// @effect-diagnostics globalDate:off -- Approval expiry is wall-clock security state.
import { createHash } from "node:crypto";
import type {
  ProviderUserInputAnswers,
  StudyBuddyEmailSendApprovalPayload,
  UserInputQuestion,
} from "@t3tools/contracts";
import {
  StudyBuddyEmailSendApprovalPayload as EmailApprovalSchema,
  UserInputQuestion as UserInputQuestionSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID = "study_buddy_email_send_v1";
const APPROVE_LABEL = "Send this email (Recommended)";
const DECLINE_LABEL = "Do not send";
const MAX_APPROVAL_LIFETIME_MS = 30 * 60 * 1_000;
const decodeEmailApproval = Schema.decodeUnknownSync(EmailApprovalSchema);
const decodeUserInputQuestions = Schema.decodeUnknownSync(Schema.Array(UserInputQuestionSchema));

interface PendingEmailApproval {
  readonly payload: StudyBuddyEmailSendApprovalPayload;
  readonly contentHash: string;
  readonly expiresAtMs: number;
}

export interface EmailApprovalExecution {
  readonly threadId: string;
  readonly requestId: string;
  readonly contentHash: string;
  readonly payload: StudyBuddyEmailSendApprovalPayload;
}

export type StudyBuddyEmailApprovalExecutor = (request: EmailApprovalExecution) => Promise<void>;

const pending = new Map<string, PendingEmailApproval>();
let registeredExecutor: StudyBuddyEmailApprovalExecutor | undefined;

export function registerStudyBuddyEmailApprovalExecutor(
  executor: StudyBuddyEmailApprovalExecutor,
): () => void {
  registeredExecutor = executor;
  return () => {
    if (registeredExecutor === executor) registeredExecutor = undefined;
  };
}

/** Captures the immutable proposal, but grants no permission. */
export function captureStudyBuddyEmailApprovalRequest(
  threadId: string,
  requestId: string | undefined,
  questions: readonly UserInputQuestion[],
): void {
  if (!requestId) return;
  const question = questions.find(
    (candidate) => candidate.id === STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID,
  );
  if (!question) return;
  if (
    question.multiSelect ||
    question.options.length !== 2 ||
    !question.options.some((option) => option.label === APPROVE_LABEL) ||
    !question.options.some((option) => option.label === DECLINE_LABEL)
  ) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(question.question);
  } catch {
    return;
  }
  let payload: StudyBuddyEmailSendApprovalPayload;
  try {
    payload = decodeEmailApproval(normalizeAddressFields(parsed));
  } catch {
    return;
  }
  const expiresAt = Date.parse(payload.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return;
  }
  // Until attachment bytes live in a broker-owned immutable store, fail closed.
  if (payload.attachments.length > 0) return;
  const frozenPayload = JSON.parse(JSON.stringify(payload)) as StudyBuddyEmailSendApprovalPayload;
  const contentHash = hashPayload(frozenPayload);
  const key = approvalKey(threadId, requestId);
  const existing = pending.get(key);
  if (existing && existing.contentHash !== contentHash) {
    pending.delete(key);
    return;
  }
  // The model proposes display metadata, but the broker owns the actual grant lifetime.
  // Clamp overly long provider values instead of showing an approval card that can never work.
  pending.set(key, {
    payload: frozenPayload,
    contentHash,
    expiresAtMs: Math.min(expiresAt, now + MAX_APPROVAL_LIFETIME_MS),
  });
}

/** Rebuilds a grant proposal from the exact request already persisted for the chat UI. */
export function captureStudyBuddyEmailApprovalActivity(
  threadId: string,
  requestId: string,
  activityPayload: unknown,
): void {
  if (!activityPayload || typeof activityPayload !== "object" || Array.isArray(activityPayload)) {
    return;
  }
  const record = activityPayload as Record<string, unknown>;
  if (record.requestId !== requestId) return;
  let questions: readonly UserInputQuestion[];
  try {
    questions = decodeUserInputQuestions(record.questions);
  } catch {
    return;
  }
  captureStudyBuddyEmailApprovalRequest(threadId, requestId, questions);
}

function normalizeAddressFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    from: normalizeAddress(record.from),
    to: normalizeAddressArray(record.to),
    cc: normalizeAddressArray(record.cc),
    bcc: normalizeAddressArray(record.bcc),
  };
}

function normalizeAddress(value: unknown): unknown {
  return typeof value === "string" ? { address: value } : value;
}

function normalizeAddressArray(value: unknown): unknown {
  return Array.isArray(value) ? value.map(normalizeAddress) : value;
}

export async function resolveStudyBuddyEmailApprovalResponse(
  threadId: string,
  requestId: string,
  answers: ProviderUserInputAnswers,
): Promise<{ handled: boolean; sent: boolean }> {
  const key = approvalKey(threadId, requestId);
  const approval = pending.get(key);
  if (!approval) return { handled: false, sent: false };
  // Consume before any external action. Ambiguous delivery failures cannot be retried
  // with the same approval because the SMTP/webmail server may already have accepted it.
  pending.delete(key);
  const selected = selectedLabels(answers[STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID]);
  if (selected.length !== 1 || selected[0] !== APPROVE_LABEL) {
    return { handled: true, sent: false };
  }
  if (approval.expiresAtMs <= Date.now()) {
    throw new Error("Email approval expired. Ask Study Buddy to prepare it again.");
  }
  const executor = registeredExecutor;
  if (!executor) throw new Error("Email sending is unavailable in this app session.");
  if (hashPayload(approval.payload) !== approval.contentHash) {
    throw new Error("Email approval no longer matches the message.");
  }
  await executor({
    threadId,
    requestId,
    contentHash: approval.contentHash,
    payload: approval.payload,
  });
  return { handled: true, sent: true };
}

export function clearStudyBuddyEmailApprovalRequestsForTest(): void {
  pending.clear();
  registeredExecutor = undefined;
}

function selectedLabels(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value && typeof value === "object" && "answers" in value) {
    return selectedLabels((value as { answers?: unknown }).answers);
  }
  return [];
}

function hashPayload(payload: StudyBuddyEmailSendApprovalPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function approvalKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}
