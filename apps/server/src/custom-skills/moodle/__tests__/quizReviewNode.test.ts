import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentBrowserClient,
  AgentBrowserCommandResult,
  AgentBrowserSnapshot,
} from "../agentBrowserClient.ts";
import type { CodexClient } from "../codexClient.ts";
import { createQuizReviewNode } from "../nodes/quizReviewNode.ts";
import { initialAgentState } from "../state.ts";
import type { MoodleRuntimeConfig, QuizSafetyPolicy } from "../types.ts";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("quizReviewNode", () => {
  it("reviews a direct quiz URL and never final-submits", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-quiz-"));
    const client = new FakeQuizBrowserClient();
    const codex: CodexClient = {
      async run() {
        return JSON.stringify({
          question_id: "question-1",
          question_index: 1,
          answer: "4",
          answers: [],
          confidence: 0.95,
          citations: ["visible option 4"],
          rationale: "2+2=4.",
          risk_flags: [],
        });
      },
    };
    const node = createQuizReviewNode(testConfig(runDir, allowQuizWorkPolicy()), {
      agentBrowser: client,
      codex,
    });

    const result = await node(initialAgentState);

    expect(result.error_log).toBeNull();
    expect(result.final_document).toContain("Final submit clicked: false");
    expect(result.final_document).toContain("Was ist 2+2?");
    expect(result.final_document).toContain("filled=true");
    expect(client.calls).toContain("click:e-start");
    expect(client.calls.some((call) => /submit all|endgültig|endgueltig/i.test(call))).toBe(false);
    await expect(readFile(path.join(runDir, "quiz-review.json"), "utf8")).resolves.toContain(
      '"final_submit_clicked": false',
    );
  });

  it("blocks risky quiz starts with conservative defaults", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-quiz-"));
    const client = new FakeQuizBrowserClient();
    const node = createQuizReviewNode(testConfig(runDir), { agentBrowser: client });

    const result = await node(initialAgentState);

    expect(result.error_log).toBeNull();
    expect(result.final_document).toContain("status: blocked");
    expect(result.final_document).toContain("reason: starting-or-continuing-attempts-disabled");
    expect(result.final_document).toContain("needed permission: allow_start_or_continue_attempt");
    expect(client.calls).not.toContain("click:e-start");
  });

  it("opens a completed attempt review before blocking a new start", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-quiz-"));
    const client = new FakeQuizBrowserClient({
      initialSnapshot: {
        refs: {
          "e-review": { role: "link", name: "Review attempt" },
          "e-start": { role: "button", name: "Test versuchen" },
        },
        snapshot:
          '- link "Review attempt" [ref=e-review] url=https://moodle.example/mod/quiz/review.php?attempt=1\n' +
          '- button "Test versuchen" [ref=e-start]',
      },
    });
    const node = createQuizReviewNode(testConfig(runDir), { agentBrowser: client });

    const result = await node(initialAgentState);

    expect(result.error_log).toBeNull();
    expect(result.final_document).toContain("Was ist 2+2?");
    expect(client.calls).toContain("click:e-review");
    expect(client.calls).not.toContain("click:e-start");
  });
});

class FakeQuizBrowserClient implements AgentBrowserClient {
  readonly calls: string[] = [];
  private started = false;
  private reviewingPreviousAttempt = false;
  private url = "https://moodle.example/mod/quiz/view.php?id=123";

  constructor(
    private readonly options: {
      initialSnapshot?: Pick<AgentBrowserSnapshot, "refs" | "snapshot">;
    } = {},
  ) {}

  async doctor(): Promise<AgentBrowserCommandResult> {
    return ok();
  }

  async open(url: string): Promise<AgentBrowserCommandResult> {
    this.calls.push(`open:${url}`);
    this.url = url;
    return ok();
  }

  async snapshot(): Promise<AgentBrowserSnapshot> {
    if (!this.started && !this.reviewingPreviousAttempt && this.options.initialSnapshot) {
      return {
        origin: this.url,
        refs: this.options.initialSnapshot.refs,
        snapshot: this.options.initialSnapshot.snapshot,
      };
    }
    return {
      origin: this.url,
      refs: { "e-start": { role: "button", name: "Test versuchen" } },
      snapshot: '- button "Test versuchen" [ref=e-start]',
    };
  }

  async getText(): Promise<string> {
    return "Dashboard";
  }

  async getTitle(): Promise<string> {
    return "Quiz";
  }

  async getUrl(): Promise<string> {
    return this.url;
  }

  async evalJson<T = unknown>(script?: string): Promise<T> {
    if (script?.includes("QUIZ_METADATA_EXTRACTION")) {
      return {
        timeLimitMinutes: null,
        attemptsAllowed: null,
        attemptsUsed: null,
        attemptsLeft: null,
        hasActiveAttempt: false,
        appearsTimed: false,
        appearsLimitedAttempt: false,
      } as T;
    }
    if (script?.includes('querySelectorAll("input:not([type])')) {
      return { filled: true, reason: "filled-choice", control: { count: 1 } } as T;
    }
    if (!this.started && !this.reviewingPreviousAttempt) {
      return {
        title: "Quiz",
        url: this.url,
        body_text: "Test versuchen",
        questions: [],
      } as T;
    }
    return {
      title: "Minitest",
      url: "https://moodle.example/mod/quiz/attempt.php?attempt=1&cmid=123",
      body_text: "Frage 1 Was ist 2+2?",
      questions: [
        {
          question_id: "question-1",
          question_index: 1,
          question_type: "multichoice",
          prompt: "Was ist 2+2?",
          options: ["3", "4"],
          controls: [
            { type: "radio", id: "q1-a", option_text: "3" },
            { type: "radio", id: "q1-b", option_text: "4" },
          ],
          visible_context: "Frage 1 Was ist 2+2? 3 4",
        },
      ],
    } as T;
  }

  async fill(): Promise<AgentBrowserCommandResult> {
    throw new Error("selector-not-found");
  }

  async click(selector: string): Promise<AgentBrowserCommandResult> {
    this.calls.push(`click:${selector}`);
    if (selector === "e-review") {
      this.reviewingPreviousAttempt = true;
      this.url = "https://moodle.example/mod/quiz/review.php?attempt=1&cmid=123";
      return ok();
    }
    this.started = true;
    return ok();
  }

  async press(): Promise<AgentBrowserCommandResult> {
    return ok();
  }

  async wait(ms: number): Promise<AgentBrowserCommandResult> {
    this.calls.push(`wait:${ms}`);
    return ok();
  }

  async download(): Promise<AgentBrowserCommandResult> {
    return ok();
  }

  async close(): Promise<AgentBrowserCommandResult> {
    this.calls.push("close");
    return ok();
  }
}

function testConfig(
  runDir: string,
  quizSafetyPolicy: QuizSafetyPolicy = conservativeQuizPolicy(),
): MoodleRuntimeConfig {
  return {
    prompt: "mach den kommenden Minitest https://moodle.example/mod/quiz/view.php?id=123",
    moodleUrl: "https://moodle.example/my",
    outputPath: path.join(runDir, "document.typ"),
    runDir,
    maxDepth: 1,
    maxPages: 4,
    maxCisPages: 0,
    allowFileDownloads: false,
    baseUrl: "https://moodle.example",
    dashboardUrl: "https://moodle.example/my",
    username: "student",
    password: "secret",
    cisUrls: [],
    cisBaseUrl: "https://cis.example",
    cisDashboardUrl: "https://cis.example",
    headless: true,
    browserBackend: "agent-browser",
    autoAnswer: true,
    quizSafetyPolicy,
  };
}

function conservativeQuizPolicy(): QuizSafetyPolicy {
  return {
    accessMode: "review-only",
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
  };
}

function allowQuizWorkPolicy(): QuizSafetyPolicy {
  return {
    ...conservativeQuizPolicy(),
    allowStartingOrContinuingAttempts: true,
    allowSuggestingAnswers: true,
    allowFillingAnswers: true,
    askBeforeTimedQuizzes: false,
    askBeforeLimitedAttemptQuizzes: false,
    askBeforeFillingAnswers: false,
  };
}

function ok(): AgentBrowserCommandResult {
  return { stdout: "", stderr: "" };
}
