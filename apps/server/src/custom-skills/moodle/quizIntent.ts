const QUIZ_TERMS = [
  "quiz",
  "test",
  "minitest",
  "kurztest",
  "testblock",
  "moodle test",
  "selbstcheck",
  "selfcheck",
  "assignment",
  "aufgabe",
];

const ACTION_TERMS = [
  "mach",
  "mache",
  "bearbeit",
  "füll",
  "fuell",
  "ausfüll",
  "ausfuell",
  "lös",
  "loes",
  "answer",
  "solve",
  "fill",
  "complete",
  "start",
  "find",
  "finde",
  "kommend",
  "heutig",
  "nächst",
  "naechst",
];

export function isQuizPrompt(prompt: string): boolean {
  const lower = prompt.toLocaleLowerCase("de-AT");
  return (
    QUIZ_TERMS.some((term) => lower.includes(term)) &&
    ACTION_TERMS.some((term) => lower.includes(term))
  );
}

export function promptWantsQuizAttempt(prompt: string): boolean {
  const lower = prompt.toLocaleLowerCase("de-AT");
  return (
    ACTION_TERMS.some((term) => lower.includes(term)) &&
    !/\b(review|inspect|prüf|pruef|nur schauen)\b/i.test(lower)
  );
}

export function extractQuizUrl(prompt: string): string | null {
  const match = /https?:\/\/\S+/i.exec(prompt);
  if (!match) {
    return null;
  }
  const url = match[0].replace(/[),.]+$/g, "");
  return url.includes("/mod/quiz/") ? url : null;
}
