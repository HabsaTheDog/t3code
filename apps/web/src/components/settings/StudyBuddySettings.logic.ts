export type QuizAccessMode = "review-only" | "ask-before-attempt" | "quiz-assist";

export interface QuizAccessModeOption {
  readonly value: QuizAccessMode;
  readonly label: string;
  readonly description: string;
}

export const QUIZ_ACCESS_TOOLTIP_DELAY_MS = 250;

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
      "Inspects quiz metadata, then shows a cooperative local confirmation before starting or continuing the attempt. This is a UX guardrail, not a security boundary against software with full machine access.",
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
