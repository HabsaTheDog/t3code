import type { UserInputQuestion } from "@t3tools/contracts";

export const STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID = "study_buddy_quiz_permission_v1";

const QUIZ_CAPABILITY_LABELS = {
  start_or_continue_attempt: "Start or continue attempt",
  read_questions: "Read questions",
  suggest_answers: "Suggest answers",
  fill_answers: "Enter answers",
  change_existing_answers: "Change existing answers",
  save_or_next_page: "Save and continue",
} as const;

export interface StudyBuddyQuizPermissionDetails {
  quizTitle: string;
  targetUrl: string | null;
  timeLimitMinutes: number | null;
  effectiveTimeLimitMinutes: number | null;
  effectiveTimeLimitSource: "quiz_time_limit" | "deadline" | "unlimited" | null;
  timeLimitUnlimited: boolean;
  attemptsAllowed: number | null;
  attemptsUsed: number | null;
  attemptsLeft: number | null;
  attemptsUnlimited: boolean;
  hasActiveAttempt: boolean | null;
  canStartNewAttempt: boolean | null;
  availabilityStatus:
    | "open"
    | "closed"
    | "not_yet_open"
    | "attempts_exhausted"
    | "unavailable"
    | "unknown"
    | null;
  opensAt: string | null;
  closesAt: string | null;
  expiresAt: string | null;
  capabilities: readonly string[];
  finalQuizSubmissionDenied: boolean;
}

export function parseStudyBuddyQuizPermissionQuestion(
  question: UserInputQuestion | null | undefined,
): StudyBuddyQuizPermissionDetails | null {
  if (!question || !looksLikeQuizPermission(question)) return null;

  const structured = parseStructuredPermission(question.question);
  if (structured) return structured;
  return parseLegacyPermission(question.question);
}

export function isStudyBuddyQuizPermissionQuestion(
  question: UserInputQuestion | null | undefined,
): boolean {
  return parseStudyBuddyQuizPermissionQuestion(question) !== null;
}

export function quizCapabilityLabel(capability: string): string {
  return QUIZ_CAPABILITY_LABELS[capability as keyof typeof QUIZ_CAPABILITY_LABELS] ?? capability;
}

export function quizPermissionOptionCopy(label: string, description: string) {
  const normalized = label.trim().toLowerCase();
  if (
    normalized === "approve this quiz" ||
    normalized.startsWith("work on quiz") ||
    normalized.startsWith("work on this quiz") ||
    normalized.startsWith("quiz bearbeiten")
  ) {
    return {
      label: "Work on quiz",
      description: "Allow Study Buddy to work on this attempt within the limits shown.",
      intent: "approve" as const,
    };
  }
  if (
    normalized === "decline" ||
    normalized === "do not allow" ||
    normalized === "nicht erlauben"
  ) {
    return {
      label: "Do not allow",
      description: "The quiz attempt will not be opened or changed.",
      intent: "decline" as const,
    };
  }
  return { label, description, intent: "neutral" as const };
}

export function formatStudyBuddyQuizTime(details: StudyBuddyQuizPermissionDetails): string {
  const deadline = formatQuizDeadline(details.closesAt);
  const effectiveMinutes = details.effectiveTimeLimitMinutes;

  if (effectiveMinutes !== null && details.effectiveTimeLimitSource === "deadline") {
    return deadline ? `${effectiveMinutes} min · until ${deadline}` : `${effectiveMinutes} min`;
  }
  if (details.timeLimitMinutes !== null) {
    const timer = `${details.timeLimitMinutes} min`;
    return deadline ? `${timer} · closes ${deadline}` : timer;
  }
  if (deadline) return `Until ${deadline}`;
  return "Unlimited";
}

function looksLikeQuizPermission(question: UserInputQuestion): boolean {
  if (question.id === STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID) return true;
  const optionLabels = question.options.map((option) => option.label.trim().toLowerCase());
  return (
    /quiz|freigeben|weiterführen/i.test(question.header) &&
    optionLabels.some(
      (label) => label === "approve this quiz" || label.startsWith("quiz bearbeiten"),
    ) &&
    optionLabels.some((label) => label === "decline" || label === "nicht erlauben")
  );
}

function parseStructuredPermission(raw: string): StudyBuddyQuizPermissionDetails | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    value.owner !== "study-buddy" ||
    value.action !== "execute_quiz_attempt" ||
    typeof value.quizTitle !== "string" ||
    !Array.isArray(value.capabilities)
  ) {
    return null;
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const timeLimitMinutes = nullableNumber(metadata.timeLimitMinutes);
  const closesAt = typeof metadata.closesAt === "string" ? metadata.closesAt : null;
  const effectiveTimeLimitMinutes = nullableNumber(metadata.effectiveTimeLimitMinutes);
  const attemptsAllowed = nullableNumber(metadata.attemptsAllowed);
  const attemptsLeft = nullableNumber(metadata.attemptsLeft);
  return {
    quizTitle: value.quizTitle.trim() || "Moodle quiz",
    targetUrl: typeof value.targetUrl === "string" ? value.targetUrl : null,
    timeLimitMinutes,
    effectiveTimeLimitMinutes,
    effectiveTimeLimitSource: parseEffectiveTimeLimitSource(metadata.effectiveTimeLimitSource),
    timeLimitUnlimited:
      metadata.timeLimitUnlimited === true ||
      (timeLimitMinutes === null && effectiveTimeLimitMinutes === null && closesAt === null),
    attemptsAllowed,
    attemptsUsed: nullableNumber(metadata.attemptsUsed),
    attemptsLeft,
    attemptsUnlimited:
      metadata.attemptsUnlimited === true || (attemptsAllowed === null && attemptsLeft === null),
    hasActiveAttempt:
      typeof metadata.hasActiveAttempt === "boolean" ? metadata.hasActiveAttempt : null,
    canStartNewAttempt:
      typeof metadata.canStartNewAttempt === "boolean" ? metadata.canStartNewAttempt : null,
    availabilityStatus: parseAvailabilityStatus(metadata.availabilityStatus),
    opensAt: typeof metadata.opensAt === "string" ? metadata.opensAt : null,
    closesAt,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
    capabilities: value.capabilities.filter(
      (capability): capability is string => typeof capability === "string",
    ),
    finalQuizSubmissionDenied: value.finalQuizSubmission === "denied",
  };
}

function parseLegacyPermission(raw: string): StudyBuddyQuizPermissionDetails | null {
  const title =
    raw.match(/[„“"]([^„“"]+?)(?:[“”"]|\.\s*(?:Zeitlimit|—\s*Zeitlimit))/i)?.[1]?.trim() ?? null;
  if (!title) return null;
  const timeLimitText = captureField(raw, "Zeitlimit");
  const attemptsLeftText = captureField(raw, "Versuche übrig");
  const permissionsText =
    raw.match(/(?:Erlaubnisse|Erlaubt):\s*(.+?)(?:\.\s*Die finale|\.\s*Finale)/i)?.[1] ?? "";
  const capabilities = permissionsText
    .split(/,|\s+sowie\s+|\s+und\s+/i)
    .map((part) => part.trim().replace(/[.]$/, ""))
    .filter(Boolean);
  return {
    quizTitle: title,
    targetUrl: null,
    timeLimitMinutes: parseFirstNumber(timeLimitText),
    effectiveTimeLimitMinutes: parseFirstNumber(timeLimitText),
    effectiveTimeLimitSource:
      parseFirstNumber(timeLimitText) === null ? "unlimited" : "quiz_time_limit",
    timeLimitUnlimited: parseFirstNumber(timeLimitText) === null,
    attemptsAllowed: null,
    attemptsUsed: null,
    attemptsLeft: parseFirstNumber(attemptsLeftText),
    attemptsUnlimited:
      /(?:unbegrenzt|unlimited|beliebig viele)/i.test(attemptsLeftText ?? "") ||
      parseFirstNumber(attemptsLeftText) === null,
    hasActiveAttempt: /(?:Versuch ist bereits|Selbstcheck ist .* noch) aktiv/i.test(raw),
    canStartNewAttempt: null,
    availabilityStatus: null,
    opensAt: null,
    closesAt: null,
    expiresAt: null,
    capabilities,
    finalQuizSubmissionDenied: /finale Abgabe .*gesperrt|finale Abgabe .*bleibt/i.test(raw),
  };
}

function captureField(raw: string, field: string): string | null {
  return raw.match(new RegExp(`${field}:\\s*([^;.—]+)`, "i"))?.[1]?.trim() ?? null;
}

function parseFirstNumber(value: string | null): number | null {
  const match = value?.match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAvailabilityStatus(
  value: unknown,
): StudyBuddyQuizPermissionDetails["availabilityStatus"] {
  return value === "open" ||
    value === "closed" ||
    value === "not_yet_open" ||
    value === "attempts_exhausted" ||
    value === "unavailable" ||
    value === "unknown"
    ? value
    : null;
}

function parseEffectiveTimeLimitSource(
  value: unknown,
): StudyBuddyQuizPermissionDetails["effectiveTimeLimitSource"] {
  return value === "quiz_time_limit" || value === "deadline" || value === "unlimited"
    ? value
    : null;
}

function formatQuizDeadline(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
