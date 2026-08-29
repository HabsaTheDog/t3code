// @effect-diagnostics nodeBuiltinImport:off -- Hashing binds approval to exact quiz scope.
// @effect-diagnostics globalDate:off -- Approval expiry is wall-clock security state.
import { createHash } from "node:crypto";
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import { UserInputQuestion as UserInputQuestionSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID = "study_buddy_quiz_permission_v1";
const APPROVE_LABEL = "Work on quiz (Recommended)";
const DECLINE_LABEL = "Do not allow";
const MAX_APPROVAL_LIFETIME_MS = 30 * 60 * 1_000;
const decodeUserInputQuestions = Schema.decodeUnknownSync(Schema.Array(UserInputQuestionSchema));

interface QuizPermissionPayload extends Record<string, unknown> {
  readonly version: 1;
  readonly owner: "study-buddy";
  readonly action: "execute_quiz_attempt";
  readonly scope: "exact_quiz_attempt";
  readonly status: "pending";
  readonly requestId: string;
  readonly targetUrl: string;
  readonly expiresAt: string;
}

interface PendingQuizApproval {
  readonly payload: QuizPermissionPayload;
  readonly contentHash: string;
  readonly expiresAtMs: number;
}

interface QuizGrant {
  readonly contentHash: string;
  readonly expiresAtMs: number;
}

const pending = new Map<string, PendingQuizApproval>();
const grants = new Map<string, QuizGrant>();

export function captureStudyBuddyQuizApprovalRequest(
  threadId: string,
  requestId: string | undefined,
  questions: readonly UserInputQuestion[],
): void {
  if (!requestId) return;
  const question = questions.find(
    (candidate) => candidate.id === STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID,
  );
  if (
    !question ||
    question.multiSelect ||
    question.options.length !== 2 ||
    !question.options.some((option) => option.label === APPROVE_LABEL) ||
    !question.options.some((option) => option.label === DECLINE_LABEL)
  ) {
    return;
  }
  let payload: QuizPermissionPayload;
  try {
    payload = decodePayload(JSON.parse(question.question));
  } catch {
    return;
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return;
  const frozenPayload = JSON.parse(JSON.stringify(payload)) as QuizPermissionPayload;
  const contentHash = hashPayload(frozenPayload);
  const key = approvalKey(threadId, requestId);
  const existing = pending.get(key);
  if (existing && existing.contentHash !== contentHash) {
    pending.delete(key);
    return;
  }
  pending.set(key, {
    payload: frozenPayload,
    contentHash,
    expiresAtMs: Math.min(expiresAtMs, now + MAX_APPROVAL_LIFETIME_MS),
  });
}

export function captureStudyBuddyQuizApprovalActivity(
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
  captureStudyBuddyQuizApprovalRequest(threadId, requestId, questions);
}

export function resolveStudyBuddyQuizApprovalResponse(
  threadId: string,
  requestId: string,
  answers: ProviderUserInputAnswers,
): { handled: boolean; approved: boolean } {
  const key = approvalKey(threadId, requestId);
  const approval = pending.get(key);
  if (!approval) return { handled: false, approved: false };
  pending.delete(key);
  const selected = selectedLabels(answers[STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID]);
  if (selected.length !== 1 || selected[0] !== APPROVE_LABEL) {
    return { handled: true, approved: false };
  }
  if (approval.expiresAtMs <= Date.now()) {
    throw new Error("Quiz approval expired. Ask Study Buddy to inspect the quiz again.");
  }
  grants.set(grantKey(approval.payload.requestId, approval.contentHash), {
    contentHash: approval.contentHash,
    expiresAtMs: approval.expiresAtMs,
  });
  return { handled: true, approved: true };
}

export function assertStudyBuddyQuizApprovalGrant(payload: unknown): void {
  const decoded = decodePayload(payload);
  const contentHash = hashPayload(decoded);
  const key = grantKey(decoded.requestId, contentHash);
  const grant = grants.get(key);
  if (!grant || grant.contentHash !== contentHash || grant.expiresAtMs <= Date.now()) {
    grants.delete(key);
    throw new Error(
      "Study Buddy quiz permission was not approved in the native confirmation card.",
    );
  }
}

export function clearStudyBuddyQuizApprovalsForTest(): void {
  pending.clear();
  grants.clear();
}

function decodePayload(value: unknown): QuizPermissionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.owner !== "study-buddy" ||
    record.action !== "execute_quiz_attempt" ||
    record.scope !== "exact_quiz_attempt" ||
    record.status !== "pending" ||
    typeof record.requestId !== "string" ||
    typeof record.targetUrl !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    throw new Error("invalid");
  }
  return record as QuizPermissionPayload;
}

function selectedLabels(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value && typeof value === "object" && "answers" in value) {
    return selectedLabels((value as { answers?: unknown }).answers);
  }
  return [];
}

function approvalKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}

function grantKey(requestId: string, contentHash: string): string {
  return `${requestId}\u0000${contentHash}`;
}

function hashPayload(payload: QuizPermissionPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
