import { describe, expect, it } from "vitest";

import {
  isQuizAccessMode,
  QUIZ_ACCESS_MODE_OPTIONS,
  QUIZ_ACCESS_TOOLTIP_DELAY_MS,
} from "./StudyBuddySettings.logic.ts";

describe("Study Buddy access modes", () => {
  it("describes Ask before attempt as a cooperative guardrail", () => {
    const option = QUIZ_ACCESS_MODE_OPTIONS.find(
      (candidate) => candidate.value === "ask-before-attempt",
    );
    expect(option?.description).toContain("cooperative local confirmation");
    expect(option?.description).toContain("not a security boundary");
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
