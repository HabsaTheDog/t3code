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
  readonly questionId: string;
  readonly approveToken: string;
  readonly declineToken: string;
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
// Persisted request activities may be replayed by the reactor. Deleting the
// pending entry alone must never make that same request a fresh grant.
const consumed = new Set<string>();
const recognized = new Map<string, readonly string[]>();
const invalid = new Map<string, string>();
const denialAnswers = new Map<string, Record<string, string>>();

export class StudyBuddyEmailApprovalError extends Error {
  readonly questionId: string;
  readonly questionIds: readonly string[];
  readonly answers: Readonly<Record<string, string>>;
  constructor(
    message: string,
    questionIds: readonly string[],
    answers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.questionIds = questionIds;
    this.answers = answers ?? Object.fromEntries(questionIds.map((id) => [id, DECLINE_LABEL]));
    this.name = "StudyBuddyEmailApprovalError";
    this.questionId = questionIds[0] ?? STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID;
  }
}
let brokerStartedAtMs = Date.now();
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
  captureEmailApprovalProposal(threadId, requestId, questions, Date.now());
}

function captureEmailApprovalProposal(
  threadId: string,
  requestId: string | undefined,
  questions: readonly UserInputQuestion[],
  firstObservedAtMs: number,
): void {
  if (!requestId) return;
  const key = approvalKey(threadId, requestId);
  const existing = pending.get(key);
  const intendedIds = questions.filter(isEmailQuestion).map((question) => question.id);
  const knownIds = recognized.get(key) ?? [];
  if (intendedIds.length > 0) recognized.set(key, [...new Set([...knownIds, ...intendedIds])]);
  rememberDenialAnswers(key, questions);
  if (consumed.has(key)) return;
  const proposal = parseProposal(questions);
  if (!proposal) {
    if (existing || intendedIds.length > 0)
      invalidate(key, "Email approval is invalid. Prepare a fresh exact-message approval.");
    return;
  }
  const { questionId, approveToken, declineToken, payload } = proposal;
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || payload.attachments.length > 0) {
    invalidate(
      key,
      "Email approval expired or contains unsupported attachments. Prepare a fresh approval.",
    );
    return;
  }
  const frozenPayload = JSON.parse(JSON.stringify(payload)) as StudyBuddyEmailSendApprovalPayload;
  const contentHash = hashPayload(frozenPayload, questionId, approveToken, declineToken);
  if (existing) {
    if (existing.contentHash !== contentHash) {
      invalidate(key, "Email approval changed. Prepare a fresh exact-message approval.");
    } else {
      pending.set(key, {
        ...existing,
        expiresAtMs: Math.min(existing.expiresAtMs, firstObservedAtMs + MAX_APPROVAL_LIFETIME_MS),
      });
    }
    // Identical reconstruction preserves the first broker-owned lifetime.
    return;
  }
  // The model proposes display metadata, but the broker owns the actual grant lifetime.
  // Clamp overly long provider values instead of showing an approval card that can never work.
  pending.set(key, {
    questionId,
    approveToken,
    declineToken,
    payload: frozenPayload,
    contentHash,
    expiresAtMs: Math.min(expiresAt, firstObservedAtMs + MAX_APPROVAL_LIFETIME_MS),
  });
}

/** Rebuilds a grant proposal from the exact request already persisted for the chat UI. */
export function captureStudyBuddyEmailApprovalActivity(
  threadId: string,
  requestId: string,
  activityPayload: unknown,
  createdAt: string | undefined,
): void {
  const key = approvalKey(threadId, requestId);
  if (!activityPayload || typeof activityPayload !== "object" || Array.isArray(activityPayload)) {
    if (pending.has(key))
      invalidate(key, "Email approval request is malformed. Prepare a fresh approval.");
    return;
  }
  const record = activityPayload as Record<string, unknown>;
  if (record.requestId !== requestId) return;
  const rawIds = Array.isArray(record.questions)
    ? record.questions.flatMap((candidate: unknown) => {
        if (!candidate || typeof candidate !== "object") return [];
        const raw = candidate as Record<string, unknown>;
        return typeof raw.id === "string" &&
          typeof raw.question === "string" &&
          isEmailQuestion({ id: raw.id, question: raw.question })
          ? [raw.id]
          : [];
      })
    : [];
  if (rawIds.length > 0)
    recognized.set(key, [...new Set([...(recognized.get(key) ?? []), ...rawIds])]);
  let questions: readonly UserInputQuestion[];
  try {
    questions = decodeUserInputQuestions(record.questions);
  } catch {
    if (pending.has(key) || rawIds.length > 0)
      invalidate(key, "Email approval request is malformed. Prepare a fresh approval.");
    return;
  }
  const intendedIds = questions.filter(isEmailQuestion).map((question) => question.id);
  if (intendedIds.length === 0) {
    if (pending.has(key))
      invalidate(key, "Email approval request changed. Prepare a fresh approval.");
    return;
  }
  recognized.set(key, [...new Set([...(recognized.get(key) ?? []), ...intendedIds])]);
  rememberDenialAnswers(key, questions);
  if (consumed.has(key)) return;
  const firstObservedAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (
    !Number.isFinite(firstObservedAtMs) ||
    firstObservedAtMs < brokerStartedAtMs ||
    firstObservedAtMs > Date.now()
  ) {
    const reason =
      "Email approval is from an earlier or unverifiable app session. Ask Study Buddy to prepare a fresh approval.";
    invalidate(key, reason);
    throw new StudyBuddyEmailApprovalError(
      reason,
      recognized.get(key) ?? intendedIds,
      denialAnswers.get(key),
    );
  }
  captureEmailApprovalProposal(threadId, requestId, questions, firstObservedAtMs);
}

// Recognition controls denial receipts, never permission. A provider-owned question
// id is accepted only after the entire proposal satisfies the structural contract.
function isEmailQuestion(question: Pick<UserInputQuestion, "id" | "question">): boolean {
  if (question.id === STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID) return true;
  try {
    const value = JSON.parse(question.question) as Record<string, unknown> | null;
    return value?.owner === "study-buddy" && value.action === "send_email" && value.version === 1;
  } catch {
    return false;
  }
}

function parseProposal(questions: readonly UserInputQuestion[]):
  | {
      questionId: string;
      approveToken: string;
      declineToken: string;
      payload: StudyBuddyEmailSendApprovalPayload;
    }
  | undefined {
  if (questions.length !== 1) return;
  const question = questions[0];
  if (
    !question ||
    !question.id ||
    question.multiSelect ||
    question.options.length !== 2 ||
    !question.options.some((option) => option.label === APPROVE_LABEL) ||
    !question.options.some((option) => option.label === DECLINE_LABEL)
  )
    return;
  const approveToken =
    question.options.find((option) => option.label === APPROVE_LABEL)?.value ?? APPROVE_LABEL;
  const declineToken =
    question.options.find((option) => option.label === DECLINE_LABEL)?.value ?? DECLINE_LABEL;
  if (
    !approveToken.trim() ||
    !declineToken.trim() ||
    approveToken === declineToken ||
    approveToken === DECLINE_LABEL ||
    declineToken === APPROVE_LABEL
  )
    return;
  try {
    return {
      questionId: question.id,
      approveToken,
      declineToken,
      payload: decodeEmailApproval(normalizeAddressFields(JSON.parse(question.question))),
    };
  } catch {
    return;
  }
}

function rememberDenialAnswers(key: string, questions: readonly UserInputQuestion[]): void {
  const answers = { ...denialAnswers.get(key) };
  for (const question of questions) {
    if (isEmailQuestion(question))
      answers[question.id] =
        question.options.find((option) => option.label === DECLINE_LABEL)?.value ?? DECLINE_LABEL;
  }
  denialAnswers.set(key, answers);
}

function invalidate(key: string, reason: string): void {
  pending.delete(key);
  consumed.add(key);
  invalid.set(key, reason);
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
): Promise<{ handled: boolean; sent: boolean; questionId?: string; answer?: string }> {
  const key = approvalKey(threadId, requestId);
  const approval = pending.get(key);
  if (!approval) {
    const questionIds = recognized.get(key);
    if (!questionIds) return { handled: false, sent: false };
    throw new StudyBuddyEmailApprovalError(
      invalid.get(key) ?? "Email approval was already consumed. Prepare a fresh approval.",
      questionIds,
      denialAnswers.get(key),
    );
  }
  // Consume before any external action. Ambiguous delivery failures cannot be retried
  // with the same approval because the SMTP/webmail server may already have accepted it.
  pending.delete(key);
  consumed.add(key);
  const selected = selectedLabels(answers[approval.questionId]);
  if (selected.length !== 1 || selected[0] !== approval.approveToken) {
    return {
      handled: true,
      sent: false,
      questionId: approval.questionId,
      answer: approval.declineToken,
    };
  }
  if (approval.expiresAtMs <= Date.now()) {
    throw new StudyBuddyEmailApprovalError(
      "Email approval expired. Ask Study Buddy to prepare it again.",
      [approval.questionId],
      { [approval.questionId]: approval.declineToken },
    );
  }
  const executor = registeredExecutor;
  if (!executor)
    throw new StudyBuddyEmailApprovalError(
      "Email sending is unavailable in this app session.",
      [approval.questionId],
      { [approval.questionId]: approval.declineToken },
    );
  if (
    hashPayload(
      approval.payload,
      approval.questionId,
      approval.approveToken,
      approval.declineToken,
    ) !== approval.contentHash
  ) {
    throw new StudyBuddyEmailApprovalError(
      "Email approval no longer matches the message.",
      [approval.questionId],
      { [approval.questionId]: approval.declineToken },
    );
  }
  try {
    await executor({
      threadId,
      requestId,
      contentHash: approval.contentHash,
      payload: approval.payload,
    });
  } catch (cause) {
    throw new StudyBuddyEmailApprovalError(
      cause instanceof Error ? cause.message : String(cause),
      [approval.questionId],
      { [approval.questionId]: approval.declineToken },
    );
  }
  return {
    handled: true,
    sent: true,
    questionId: approval.questionId,
    answer: approval.approveToken,
  };
}

export function clearStudyBuddyEmailApprovalRequestsForTest(): void {
  pending.clear();
  consumed.clear();
  recognized.clear();
  invalid.clear();
  denialAnswers.clear();
  brokerStartedAtMs = Date.now();
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

function hashPayload(
  payload: StudyBuddyEmailSendApprovalPayload,
  questionId: string,
  approveToken: string,
  declineToken: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ questionId, approveToken, declineToken, payload }))
    .digest("hex");
}

function approvalKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}
