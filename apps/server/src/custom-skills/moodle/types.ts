import type { AgentState, SourceCoverage } from "./state.ts";
import type { CalendarSelection } from "./calendarAdapter.ts";

export interface MoodleGraphInput {
  prompt: string;
  moodleUrl: string;
  outputPath?: string | undefined;
  maxDepth?: number | undefined;
  maxPages?: number | undefined;
  allowFileDownloads?: boolean | undefined;
  cisUrls?: string[] | undefined;
  calendarUrl?: string | undefined;
  maxCisPages?: number | undefined;
  browserBackend?: BrowserBackend | undefined;
  cisBrowserBackend?: BrowserBackend | undefined;
  browserHeaded?: boolean | undefined;
  keepBrowserOpen?: boolean | undefined;
  browserMaxOutput?: number | undefined;
  autoAnswer?: boolean | undefined;
  quizSafetyPolicy?: Partial<QuizSafetyPolicy> | undefined;
  codexModel?: string | undefined;
}

export interface MoodleGraphResult {
  ok: boolean;
  coverageComplete: boolean;
  outputPath?: string;
  pdfPath?: string;
  answerPath?: string;
  answerJsonPath?: string;
  state: AgentState;
  sourceCoverage: SourceCoverage;
  error?: string;
}

export interface MoodleRuntimeConfig {
  prompt: string;
  moodleUrl: string;
  outputPath: string;
  runDir: string;
  maxDepth: number;
  maxPages: number;
  maxCisPages: number;
  allowFileDownloads: boolean;
  baseUrl: string;
  dashboardUrl: string;
  username?: string | undefined;
  password?: string | undefined;
  storageState?: string | undefined;
  cisUrls: string[];
  calendarUrl?: string | undefined;
  cisBaseUrl: string;
  cisDashboardUrl: string;
  cisUsername?: string | undefined;
  cisPassword?: string | undefined;
  cisStorageState?: string | undefined;
  headless: boolean;
  browserBackend?: BrowserBackend | undefined;
  cisBrowserBackend?: BrowserBackend | undefined;
  agentBrowserBin?: string | undefined;
  browserSession?: string | undefined;
  browserSessionName?: string | undefined;
  browserAllowedDomains?: string[] | undefined;
  browserActionPolicyPath?: string | undefined;
  browserMaxOutput?: number | undefined;
  keepBrowserOpen?: boolean | undefined;
  autoAnswer?: boolean | undefined;
  quizSafetyPolicy?: QuizSafetyPolicy | undefined;
  codexModel?: string | undefined;
  calendarSelection?: CalendarSelection | undefined;
}

export type BrowserBackend = "agent-browser" | "playwright";

export type QuizAccessMode = "review-only" | "ask-before-attempt" | "quiz-assist";

export interface QuizSafetyPolicy {
  accessMode: QuizAccessMode;
  allowOpeningQuizPages: boolean;
  allowStartingOrContinuingAttempts: boolean;
  minimumTimeLimitMinutes: number;
  minimumAttemptsLeft: number;
  allowReadingQuestions: boolean;
  allowSuggestingAnswers: boolean;
  allowFillingAnswers: boolean;
  allowChangingExistingAnswers: boolean;
  allowSavingMovingNext: boolean;
  askBeforeTimedQuizzes: boolean;
  askBeforeLimitedAttemptQuizzes: boolean;
  askBeforeFillingAnswers: boolean;
  askBeforeChangingExistingAnswers: boolean;
  fillConfidenceThreshold: number;
  finalSubmissionBlocked: true;
}
