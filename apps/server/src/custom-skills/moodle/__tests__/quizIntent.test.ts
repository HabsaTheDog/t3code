import { describe, expect, it } from "vitest";
import { extractQuizUrl, isQuizPrompt } from "../quizIntent.ts";

describe("quizIntent", () => {
  it("routes German minitest prompts to the quiz path", () => {
    expect(
      isQuizPrompt("kannst du bitte den kommenden minitest in Anwendung der Dynamik machen"),
    ).toBe(true);
  });

  it("routes German selfcheck prompts to the quiz path", () => {
    expect(isQuizPrompt("bearbeite bitte die Selbstchecks in Elektrotechnik 2")).toBe(true);
  });

  it("does not route ordinary schedule questions as quiz attempts", () => {
    expect(isQuizPrompt("was machen wir heute im fachlabor und in welchem raum")).toBe(false);
  });

  it("extracts direct Moodle quiz URLs", () => {
    expect(extractQuizUrl("mach https://moodle.technikum-wien.at/mod/quiz/view.php?id=123.")).toBe(
      "https://moodle.technikum-wien.at/mod/quiz/view.php?id=123",
    );
  });
});
