import { describe, expect, it } from "vitest";

import {
  isQuizAccessMode,
  QUIZ_ACCESS_MODE_OPTIONS,
  QUIZ_ACCESS_TOOLTIP_DELAY_MS,
} from "./StudyBuddySettings.logic.ts";

describe("Study Buddy access modes", () => {
  it("plainly describes what Ask before opening a quiz does", () => {
    const option = QUIZ_ACCESS_MODE_OPTIONS.find(
      (candidate) => candidate.value === "ask-before-attempt",
    );
    expect(option?.description).toBe(
      "Study Buddy shows you what it found and asks before it opens or continues a quiz.",
    );
  });

  it("exposes all supported study access levels", () => {
    expect(QUIZ_ACCESS_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "review-only",
      "ask-before-attempt",
      "quiz-assist",
    ]);
    expect(isQuizAccessMode("unsupported-mode")).toBe(false);
  });

  it("waits for an intentional hover before showing access-mode details", () => {
    expect(QUIZ_ACCESS_TOOLTIP_DELAY_MS).toBe(250);
  });
});
