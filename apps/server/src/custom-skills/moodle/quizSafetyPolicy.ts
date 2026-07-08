import type { AgentBrowserClient } from "./agentBrowserClient.ts";
import type { QuizSafetyPolicy } from "./types.ts";
import type { AnswerSpec, QuizQuestion } from "./nodes/quizReviewNode.ts";

export type QuizSafetyAction =
  | "open_quiz_page"
  | "start_or_continue_attempt"
  | "read_questions"
  | "suggest_answers"
  | "fill_answers"
  | "change_existing_answers"
  | "save_or_next_page"
  | "final_submit";

export interface QuizMetadata {
  timeLimitMinutes: number | null;
  attemptsAllowed: number | null;
  attemptsUsed: number | null;
  attemptsLeft: number | null;
  hasActiveAttempt: boolean;
  appearsTimed: boolean;
  appearsLimitedAttempt: boolean;
}

export type QuizPolicyDecision =
  | {
      status: "allowed";
      action: QuizSafetyAction;
      reason?: string;
      neededPermission?: string;
    }
  | {
      status: "blocked" | "permission_required";
      action: QuizSafetyAction;
      reason: string;
      neededPermission: string;
    };

export const DEFAULT_QUIZ_SAFETY_POLICY: QuizSafetyPolicy = {
  allowOpeningQuizPages: true,
  allowStartingOrContinuingAttempts: false,
  minimumTimeLimitMinutes: 10,
  minimumAttemptsLeft: 2,
  allowReadingQuestions: true,
  allowSuggestingAnswers: false,
  allowFillingAnswers: false,
  allowChangingExistingAnswers: false,
  allowSavingMovingNext: false,
  askBeforeTimedQuizzes: true,
  askBeforeLimitedAttemptQuizzes: true,
  askBeforeFillingAnswers: true,
  askBeforeChangingExistingAnswers: true,
  fillConfidenceThreshold: 0.85,
  finalSubmissionBlocked: true,
  accessMode: "review-only",
};

const QUIZ_METADATA_EXTRACTION_JS = String.raw`
(() => {
  const marker = "QUIZ_METADATA_EXTRACTION";
  void marker;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const bodyText = normalize(document.body ? document.body.innerText || document.body.textContent : "");
  const lower = bodyText.toLowerCase();
  const numberAfter = patterns => {
    for (const pattern of patterns) {
      const match = pattern.exec(bodyText);
      if (match) return Number(match[1]);
    }
    return null;
  };
  const timeMatch = [
    /(?:time limit|zeitbegrenzung|zeitlimit)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(minutes?|mins?|minuten?|min\b)/i,
    /(?:time limit|zeitbegrenzung|zeitlimit)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(hours?|stunden?|std\.?)/i
  ].map(pattern => pattern.exec(bodyText));
  let timeLimitMinutes = null;
  if (timeMatch[0]) timeLimitMinutes = Number(String(timeMatch[0][1]).replace(",", "."));
  if (timeMatch[1]) timeLimitMinutes = Number(String(timeMatch[1][1]).replace(",", ".")) * 60;
  const attemptsAllowed = numberAfter([
    /attempts allowed\s*:?\s*(\d+)/i,
    /allowed attempts\s*:?\s*(\d+)/i,
    /erlaubte versuche\s*:?\s*(\d+)/i,
    /versuche erlaubt\s*:?\s*(\d+)/i
  ]);
  const attemptsUsed = numberAfter([
    /attempts used\s*:?\s*(\d+)/i,
    /used attempts\s*:?\s*(\d+)/i,
    /versuche verwendet\s*:?\s*(\d+)/i,
    /verwendete versuche\s*:?\s*(\d+)/i,
    /bisherige versuche\s*:?\s*(\d+)/i
  ]);
  const explicitAttemptsLeft = numberAfter([
    /attempts left\s*:?\s*(\d+)/i,
    /remaining attempts\s*:?\s*(\d+)/i,
    /verbleibende versuche\s*:?\s*(\d+)/i,
    /versuche übrig\s*:?\s*(\d+)/i,
    /versuche uebrig\s*:?\s*(\d+)/i
  ]);
  const attemptsLeft = explicitAttemptsLeft ?? (
    attemptsAllowed !== null && attemptsUsed !== null ? Math.max(0, attemptsAllowed - attemptsUsed) : null
  );
  const hasActiveAttempt = /continue attempt|attempt in progress|versuch fortsetzen|laufender versuch|fortsetzen/i.test(bodyText);
  const appearsTimed = timeLimitMinutes !== null || /time limit|zeitbegrenzung|zeitlimit/i.test(bodyText);
  const appearsLimitedAttempt = attemptsAllowed !== null || attemptsLeft !== null || /attempts allowed|erlaubte versuche|versuche erlaubt/i.test(bodyText);
  return JSON.stringify({
    timeLimitMinutes,
    attemptsAllowed,
    attemptsUsed,
    attemptsLeft,
    hasActiveAttempt,
    appearsTimed,
    appearsLimitedAttempt,
    bodyText: lower.slice(0, 0)
  });
})()
`;

export async function extractQuizMetadata(client: AgentBrowserClient): Promise<QuizMetadata> {
  const metadata = await client.evalJson<Partial<QuizMetadata>>(QUIZ_METADATA_EXTRACTION_JS);
  return normalizeQuizMetadata(metadata);
}

export function normalizeQuizMetadata(value: Partial<QuizMetadata> = {}): QuizMetadata {
  const attemptsLeft =
    finiteOrNull(value.attemptsLeft) ??
    (finiteOrNull(value.attemptsAllowed) !== null && finiteOrNull(value.attemptsUsed) !== null
      ? Math.max(0, Number(value.attemptsAllowed) - Number(value.attemptsUsed))
      : null);
  const timeLimitMinutes = finiteOrNull(value.timeLimitMinutes);
  const attemptsAllowed = finiteOrNull(value.attemptsAllowed);
  const attemptsUsed = finiteOrNull(value.attemptsUsed);
  return {
    timeLimitMinutes,
    attemptsAllowed,
    attemptsUsed,
    attemptsLeft,
    hasActiveAttempt: value.hasActiveAttempt === true,
    appearsTimed: value.appearsTimed === true || timeLimitMinutes !== null,
    appearsLimitedAttempt:
      value.appearsLimitedAttempt === true || attemptsAllowed !== null || attemptsLeft !== null,
  };
}

export function enforceQuizSafetyPolicy(
  policy: QuizSafetyPolicy | undefined,
  action: QuizSafetyAction,
  context: {
    metadata?: QuizMetadata;
    question?: QuizQuestion;
    answer?: AnswerSpec;
  } = {},
): QuizPolicyDecision {
  const effectivePolicy = policy ?? DEFAULT_QUIZ_SAFETY_POLICY;
  switch (action) {
    case "open_quiz_page":
      return effectivePolicy.allowOpeningQuizPages
        ? allowed(action)
        : blocked(action, "opening-quiz-pages-disabled", "allow_opening_quiz_pages");
    case "start_or_continue_attempt":
      return enforceAttemptPolicy(effectivePolicy, context.metadata);
    case "read_questions":
      return effectivePolicy.allowReadingQuestions
        ? allowed(action)
        : blocked(action, "reading-questions-disabled", "allow_reading_questions");
    case "suggest_answers":
      return effectivePolicy.allowSuggestingAnswers
        ? allowed(action)
        : blocked(action, "answer-suggestions-disabled", "allow_suggesting_answers");
    case "fill_answers":
      return enforceFillPolicy(effectivePolicy, context.question, context.answer);
    case "change_existing_answers":
      return enforceChangeExistingPolicy(effectivePolicy);
    case "save_or_next_page":
      return effectivePolicy.allowSavingMovingNext
        ? allowed(action)
        : blocked(action, "save-next-disabled", "allow_save_or_next_page");
    case "final_submit":
      return blocked(action, "final-submission-manual-only", "manual_final_submission");
  }
}

export function questionHasExistingAnswer(question: QuizQuestion): boolean {
  return question.controls.some((control) => {
    if (control.checked === true) {
      return true;
    }
    const value = control.value;
    return typeof value === "string" && value.trim().length > 0;
  });
}

function enforceAttemptPolicy(
  policy: QuizSafetyPolicy,
  metadata: QuizMetadata | undefined,
): QuizPolicyDecision {
  const action: QuizSafetyAction = "start_or_continue_attempt";
  if (!policy.allowStartingOrContinuingAttempts) {
    return blocked(
      action,
      "starting-or-continuing-attempts-disabled",
      "allow_start_or_continue_attempt",
    );
  }
  if (
    metadata?.appearsTimed &&
    metadata.timeLimitMinutes !== null &&
    metadata.timeLimitMinutes < policy.minimumTimeLimitMinutes
  ) {
    return blocked(action, "timed-quiz-below-minimum-time-limit", "allow_lower_time_limit");
  }
  if (
    metadata?.appearsLimitedAttempt &&
    metadata.attemptsLeft !== null &&
    metadata.attemptsLeft < policy.minimumAttemptsLeft
  ) {
    return blocked(
      action,
      "limited-attempt-quiz-below-minimum-attempts-left",
      "allow_lower_attempts_left",
    );
  }
  if (metadata?.appearsTimed && policy.askBeforeTimedQuizzes) {
    return permissionRequired(action, "timed-quiz-needs-confirmation", "confirm_timed_quiz");
  }
  if (metadata?.appearsLimitedAttempt && policy.askBeforeLimitedAttemptQuizzes) {
    return permissionRequired(
      action,
      "limited-attempt-quiz-needs-confirmation",
      "confirm_limited_attempt_quiz",
    );
  }
  return allowed(action);
}

function enforceFillPolicy(
  policy: QuizSafetyPolicy,
  question: QuizQuestion | undefined,
  answer: AnswerSpec | undefined,
): QuizPolicyDecision {
  const action: QuizSafetyAction = "fill_answers";
  if (!policy.allowFillingAnswers) {
    return blocked(action, "filling-answers-disabled", "allow_filling_answers");
  }
  const confidence = Number(answer?.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < policy.fillConfidenceThreshold) {
    return blocked(action, "answer-confidence-below-threshold", "lower_fill_confidence_threshold");
  }
  if (question && questionHasExistingAnswer(question)) {
    const changeDecision = enforceChangeExistingPolicy(policy);
    if (changeDecision.status !== "allowed") {
      return changeDecision;
    }
  }
  if (policy.askBeforeFillingAnswers) {
    return permissionRequired(
      action,
      "filling-answers-needs-confirmation",
      "confirm_filling_answers",
    );
  }
  return allowed(action);
}

function enforceChangeExistingPolicy(policy: QuizSafetyPolicy): QuizPolicyDecision {
  const action: QuizSafetyAction = "change_existing_answers";
  if (!policy.allowChangingExistingAnswers) {
    return blocked(action, "changing-existing-answers-disabled", "allow_changing_existing_answers");
  }
  if (policy.askBeforeChangingExistingAnswers) {
    return permissionRequired(
      action,
      "changing-existing-answers-needs-confirmation",
      "confirm_changing_existing_answers",
    );
  }
  return allowed(action);
}

function allowed(action: QuizSafetyAction): QuizPolicyDecision {
  return { status: "allowed", action };
}

function blocked(
  action: QuizSafetyAction,
  reason: string,
  neededPermission: string,
): QuizPolicyDecision {
  return { status: "blocked", action, reason, neededPermission };
}

function permissionRequired(
  action: QuizSafetyAction,
  reason: string,
  neededPermission: string,
): QuizPolicyDecision {
  return { status: "permission_required", action, reason, neededPermission };
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
