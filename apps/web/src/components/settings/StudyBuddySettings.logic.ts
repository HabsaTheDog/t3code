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
    label: "Review completed quizzes",
    description:
      "Study Buddy may read questions from quizzes you already finished to help you study. It will never start a quiz or fill in answers.",
  },
  {
    value: "ask-before-attempt",
    label: "Ask before opening a quiz",
    description:
      "Study Buddy shows you what it found and asks before it opens or continues a quiz.",
  },
  {
    value: "quiz-assist",
    label: "Help during quizzes",
    description:
      "Study Buddy may open a quiz, suggest or fill in answers, and save each page. Only you can submit the quiz.",
  },
];

export function isQuizAccessMode(value: string | null | undefined): value is QuizAccessMode {
  return QUIZ_ACCESS_MODE_OPTIONS.some((option) => option.value === value);
}
