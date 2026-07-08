export type QuizAccessMode = "review-only" | "ask-before-attempt" | "quiz-assist";

export interface QuizAccessModeOption {
  readonly value: QuizAccessMode;
  readonly label: string;
  readonly description: string;
}

export const QUIZ_ACCESS_MODE_OPTIONS: readonly QuizAccessModeOption[] = [
  {
    value: "review-only",
    label: "Review previous attempts",
    description:
      "May open completed quiz attempts and read their visible questions. Never starts a new attempt or fills answers.",
  },
  {
    value: "ask-before-attempt",
    label: "Ask before attempt",
    description:
      "May prepare suggestions, but stops for explicit permission before risky quiz work.",
  },
  {
    value: "quiz-assist",
    label: "Quiz assist",
    description:
      "May start, suggest, fill, change, and save pages. Final submit stays manual-only.",
  },
];

export function isQuizAccessMode(value: string | null | undefined): value is QuizAccessMode {
  return QUIZ_ACCESS_MODE_OPTIONS.some((option) => option.value === value);
}
