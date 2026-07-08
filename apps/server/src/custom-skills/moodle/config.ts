import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type {
  MoodleGraphInput,
  MoodleRuntimeConfig,
  QuizAccessMode,
  QuizSafetyPolicy,
} from "./types.ts";

const DEFAULT_BROWSER_BACKEND = "agent-browser";
const DEFAULT_BROWSER_MAX_OUTPUT = 50_000;
const DEFAULT_BROWSER_ALLOWED_DOMAINS = [
  "moodle.technikum-wien.at",
  "cis.technikum-wien.at",
  "*.technikum-wien.at",
];
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(MODULE_DIR, "../../..");
const T3_ROOT = path.resolve(MODULE_DIR, "../../../../..");

loadEnvFiles();

export function createRuntimeConfig(input: MoodleGraphInput): MoodleRuntimeConfig {
  if (!input.prompt.trim()) {
    throw new Error("prompt is required.");
  }
  if (!input.moodleUrl.trim()) {
    throw new Error("moodleUrl is required.");
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const outputRoot = path.join(workspaceRoot, "output", requestSlug(input.prompt));
  const explicitOutputPath = input.outputPath
    ? resolveWorkspacePath(input.outputPath, workspaceRoot)
    : null;
  const runDir = explicitOutputPath
    ? path.dirname(explicitOutputPath)
    : path.resolve(outputRoot, timestampSlug());
  mkdirSync(runDir, { recursive: true });
  const runSlug = path.basename(runDir).replace(/[^a-z0-9_-]+/gi, "-") || "run";
  const browserBackend = parseBrowserBackend(
    input.browserBackend || process.env.MOODLE_BROWSER_BACKEND,
  );
  const cisBrowserBackend = parseBrowserBackend(process.env.CIS_BROWSER_BACKEND || "playwright");
  const quizSafetyPolicy = createQuizSafetyPolicy(input.quizSafetyPolicy);

  return {
    prompt: input.prompt,
    moodleUrl: input.moodleUrl,
    outputPath: explicitOutputPath || path.resolve(path.join(runDir, "document.typ")),
    runDir,
    maxDepth: input.maxDepth ?? 1,
    maxPages: input.maxPages ?? 12,
    maxCisPages: input.maxCisPages ?? parsePositiveInteger(process.env.CIS_MAX_PAGES, 8),
    allowFileDownloads: input.allowFileDownloads ?? true,
    baseUrl: process.env.MOODLE_BASE_URL || new URL(input.moodleUrl).origin,
    dashboardUrl: process.env.MOODLE_DASHBOARD_URL || input.moodleUrl,
    username: process.env.MOODLE_USERNAME,
    password: process.env.MOODLE_PASSWORD,
    storageState: process.env.MOODLE_STORAGE_STATE || undefined,
    cisUrls: input.cisUrls?.length ? input.cisUrls : parseUrlList(process.env.CIS_URLS),
    calendarUrl: input.calendarUrl?.trim() || process.env.CIS_CALENDAR_URL?.trim() || undefined,
    cisBaseUrl:
      process.env.CIS_BASE_URL ||
      inferBaseUrl(input.cisUrls?.[0] || parseUrlList(process.env.CIS_URLS)[0]),
    cisDashboardUrl:
      process.env.CIS_DASHBOARD_URL ||
      input.cisUrls?.[0] ||
      parseUrlList(process.env.CIS_URLS)[0] ||
      "",
    cisUsername: process.env.CIS_USERNAME || process.env.MOODLE_USERNAME,
    cisPassword: process.env.CIS_PASSWORD || process.env.MOODLE_PASSWORD,
    cisStorageState: process.env.CIS_STORAGE_STATE || undefined,
    headless: input.browserHeaded ? false : process.env.MOODLE_HEADLESS !== "false",
    browserBackend,
    cisBrowserBackend,
    agentBrowserBin: process.env.AGENT_BROWSER_BIN || undefined,
    browserSession: process.env.MOODLE_BROWSER_SESSION || `study-buddy-${runSlug}`,
    browserSessionName: process.env.MOODLE_BROWSER_SESSION_NAME || "study-buddy-technikum",
    browserAllowedDomains: parseUrlList(process.env.MOODLE_BROWSER_ALLOWED_DOMAINS).length
      ? parseUrlList(process.env.MOODLE_BROWSER_ALLOWED_DOMAINS)
      : DEFAULT_BROWSER_ALLOWED_DOMAINS,
    browserActionPolicyPath:
      process.env.MOODLE_BROWSER_ACTION_POLICY ||
      path.resolve(path.join(MODULE_DIR, "config", "agent-browser.policy.json")),
    browserMaxOutput:
      input.browserMaxOutput ??
      parsePositiveInteger(process.env.MOODLE_BROWSER_MAX_OUTPUT, DEFAULT_BROWSER_MAX_OUTPUT),
    keepBrowserOpen: input.keepBrowserOpen ?? process.env.MOODLE_BROWSER_KEEP_OPEN === "true",
    autoAnswer: input.autoAnswer ?? quizSafetyPolicy.allowFillingAnswers,
    quizSafetyPolicy,
    codexModel: trimOptional(input.codexModel) ?? trimOptional(process.env.STUDY_BUDDY_CODEX_MODEL),
  };
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function createQuizSafetyPolicy(
  overrides: Partial<QuizSafetyPolicy> = {},
): QuizSafetyPolicy {
  const accessMode = parseQuizAccessMode(process.env.MOODLE_QUIZ_ACCESS_MODE);
  const basePolicy = accessMode ? quizAccessModePolicy(accessMode) : legacyQuizSafetyPolicy();
  return {
    ...basePolicy,
    minimumTimeLimitMinutes: parseNonNegativeNumber(
      process.env.MOODLE_QUIZ_MIN_TIME_LIMIT_MINUTES,
      basePolicy.minimumTimeLimitMinutes,
    ),
    minimumAttemptsLeft: parseNonNegativeNumber(
      process.env.MOODLE_QUIZ_MIN_ATTEMPTS_LEFT,
      basePolicy.minimumAttemptsLeft,
    ),
    fillConfidenceThreshold: parseBoundedNumber(
      process.env.MOODLE_QUIZ_FILL_CONFIDENCE_THRESHOLD,
      basePolicy.fillConfidenceThreshold,
      0,
      1,
    ),
    ...overrides,
    finalSubmissionBlocked: true,
  };
}

function legacyQuizSafetyPolicy(): QuizSafetyPolicy {
  return {
    accessMode: "review-only",
    allowOpeningQuizPages: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_OPEN, true),
    allowStartingOrContinuingAttempts: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_ATTEMPT, false),
    minimumTimeLimitMinutes: 10,
    minimumAttemptsLeft: 2,
    allowReadingQuestions: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_READ_QUESTIONS, true),
    allowSuggestingAnswers: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_SUGGEST_ANSWERS, false),
    allowFillingAnswers: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_FILL_ANSWERS, false),
    allowChangingExistingAnswers: parseBoolean(
      process.env.MOODLE_QUIZ_ALLOW_CHANGE_EXISTING_ANSWERS,
      false,
    ),
    allowSavingMovingNext: parseBoolean(process.env.MOODLE_QUIZ_ALLOW_SAVE_NEXT, false),
    askBeforeTimedQuizzes: parseBoolean(process.env.MOODLE_QUIZ_ASK_BEFORE_TIMED, true),
    askBeforeLimitedAttemptQuizzes: parseBoolean(
      process.env.MOODLE_QUIZ_ASK_BEFORE_LIMITED_ATTEMPTS,
      true,
    ),
    askBeforeFillingAnswers: parseBoolean(process.env.MOODLE_QUIZ_ASK_BEFORE_FILL, true),
    askBeforeChangingExistingAnswers: parseBoolean(
      process.env.MOODLE_QUIZ_ASK_BEFORE_CHANGE_EXISTING,
      true,
    ),
    fillConfidenceThreshold: 0.85,
    finalSubmissionBlocked: true,
  };
}

function quizAccessModePolicy(accessMode: QuizAccessMode): QuizSafetyPolicy {
  const common = {
    accessMode,
    minimumTimeLimitMinutes: 10,
    minimumAttemptsLeft: 2,
    fillConfidenceThreshold: 0.85,
    finalSubmissionBlocked: true,
  } as const;
  switch (accessMode) {
    case "review-only":
      return {
        ...common,
        allowOpeningQuizPages: true,
        allowStartingOrContinuingAttempts: false,
        allowReadingQuestions: true,
        allowSuggestingAnswers: false,
        allowFillingAnswers: false,
        allowChangingExistingAnswers: false,
        allowSavingMovingNext: false,
        askBeforeTimedQuizzes: true,
        askBeforeLimitedAttemptQuizzes: true,
        askBeforeFillingAnswers: true,
        askBeforeChangingExistingAnswers: true,
      };
    case "ask-before-attempt":
      return {
        ...common,
        allowOpeningQuizPages: true,
        allowStartingOrContinuingAttempts: true,
        allowReadingQuestions: true,
        allowSuggestingAnswers: true,
        allowFillingAnswers: true,
        allowChangingExistingAnswers: true,
        allowSavingMovingNext: false,
        askBeforeTimedQuizzes: true,
        askBeforeLimitedAttemptQuizzes: true,
        askBeforeFillingAnswers: true,
        askBeforeChangingExistingAnswers: true,
      };
    case "quiz-assist":
      return {
        ...common,
        allowOpeningQuizPages: true,
        allowStartingOrContinuingAttempts: true,
        allowReadingQuestions: true,
        allowSuggestingAnswers: true,
        allowFillingAnswers: true,
        allowChangingExistingAnswers: true,
        allowSavingMovingNext: true,
        askBeforeTimedQuizzes: false,
        askBeforeLimitedAttemptQuizzes: false,
        askBeforeFillingAnswers: false,
        askBeforeChangingExistingAnswers: false,
      };
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveWorkspaceRoot(): string {
  return path.resolve(process.env.STUDY_BUDDY_WORKSPACE || process.env.T3CODE_CWD || process.cwd());
}

function resolveWorkspacePath(value: string, workspaceRoot: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function requestSlug(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^a-z0-9äöüß_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "moodle-run"
  );
}

function parseUrlList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function inferBaseUrl(url: string | undefined): string {
  if (!url) {
    return process.env.CIS_BASE_URL || "https://cis.technikum-wien.at";
  }
  return new URL(url).origin;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseBrowserBackend(value: string | undefined): "agent-browser" | "playwright" {
  if (!value) {
    return DEFAULT_BROWSER_BACKEND;
  }
  if (value === "agent-browser" || value === "playwright") {
    return value;
  }
  throw new Error(
    `Expected MOODLE_BROWSER_BACKEND to be agent-browser or playwright, got ${value}`,
  );
}

function parseQuizAccessMode(value: string | undefined): QuizAccessMode | null {
  if (value === "info-only") {
    return "review-only";
  }
  if (value === "review-only" || value === "ask-before-attempt" || value === "quiz-assist") {
    return value;
  }
  return null;
}

export function loadEnvFiles(candidates = defaultEnvFileCandidates()): void {
  for (const envPath of new Set(candidates)) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

function defaultEnvFileCandidates(): string[] {
  return [
    ...(process.env.STUDY_BUDDY_ROOT
      ? [path.join(process.env.STUDY_BUDDY_ROOT, ".env.local")]
      : []),
    path.resolve(process.cwd(), ".env.local"),
    path.join(SERVER_ROOT, ".env.local"),
    path.join(T3_ROOT, ".env.local"),
    ...(process.env.STUDY_BUDDY_ROOT ? [path.join(process.env.STUDY_BUDDY_ROOT, ".env")] : []),
    path.resolve(process.cwd(), ".env"),
    path.join(SERVER_ROOT, ".env"),
    path.join(T3_ROOT, ".env"),
  ];
}
