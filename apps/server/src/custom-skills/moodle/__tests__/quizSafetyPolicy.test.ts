import { describe, expect, it } from "vitest";
import {
  enforceQuizSafetyPolicy,
  normalizeQuizMetadata,
  type QuizMetadata,
} from "../quizSafetyPolicy.ts";
import type { QuizQuestion } from "../nodes/quizReviewNode.ts";
import type { QuizSafetyPolicy } from "../types.ts";

describe("quizSafetyPolicy", () => {
  it("blocks timed quizzes below the minimum time limit", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ allowStartingOrContinuingAttempts: true }),
      "start_or_continue_attempt",
      {
        metadata: metadata({ timeLimitMinutes: 5, appearsTimed: true }),
      },
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("timed-quiz-below-minimum-time-limit");
  });

  it("blocks limited-attempt quizzes below the minimum attempts left", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ allowStartingOrContinuingAttempts: true }),
      "start_or_continue_attempt",
      {
        metadata: metadata({
          attemptsAllowed: 2,
          attemptsUsed: 1,
          attemptsLeft: 1,
          appearsLimitedAttempt: true,
        }),
      },
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("limited-attempt-quiz-below-minimum-attempts-left");
  });

  it("prevents filling when filling is disabled", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ allowFillingAnswers: false }),
      "fill_answers",
      {
        question: question(),
        answer: answer(0.99),
      },
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("filling-answers-disabled");
  });

  it("prevents filling answers below the confidence threshold", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ allowFillingAnswers: true }),
      "fill_answers",
      {
        question: question(),
        answer: answer(0.6),
      },
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("answer-confidence-below-threshold");
  });

  it("does not overwrite existing answers unless changing is allowed", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ allowFillingAnswers: true }),
      "fill_answers",
      {
        question: question([{ type: "radio", checked: true, value: "4" }]),
        answer: answer(0.99),
      },
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("changing-existing-answers-disabled");
  });

  it("blocks save or next page unless allowed", () => {
    const decision = enforceQuizSafetyPolicy(policy(), "save_or_next_page");

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("save-next-disabled");
  });

  it("keeps final submit blocked regardless of settings", () => {
    const decision = enforceQuizSafetyPolicy(
      policy({ finalSubmissionBlocked: true }),
      "final_submit",
    );

    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("final-submission-manual-only");
  });
});

function policy(overrides: Partial<QuizSafetyPolicy> = {}): QuizSafetyPolicy {
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
    askBeforeTimedQuizzes: false,
    askBeforeLimitedAttemptQuizzes: false,
    askBeforeFillingAnswers: false,
    askBeforeChangingExistingAnswers: false,
    fillConfidenceThreshold: 0.85,
    ...overrides,
    finalSubmissionBlocked: true,
  };
}

function metadata(overrides: Partial<QuizMetadata>): QuizMetadata {
  return normalizeQuizMetadata(overrides);
}

function question(controls: Array<Record<string, unknown>> = []): QuizQuestion {
  return {
    question_id: "question-1",
    question_index: 1,
    question_type: "multichoice",
    prompt: "Was ist 2+2?",
    options: ["3", "4"],
    controls,
    visible_context: "Frage 1 Was ist 2+2?",
  };
}

function answer(confidence: number) {
  return {
    question_id: "question-1",
    question_index: 1,
    answer: "4",
    answers: [],
    confidence,
    citations: ["visible option 4"],
    rationale: "2+2=4.",
    risk_flags: [],
  };
}
