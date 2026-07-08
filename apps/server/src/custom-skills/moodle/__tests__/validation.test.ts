import { describe, expect, it } from "vitest";
import { STUDY_BUDDY_TEMPLATE_FILE, STUDY_BUDDY_TYPST_TEMPLATE } from "../typstTemplate.ts";
import { parseJsonObjectOrArray, validateExtractedData, validateTypst } from "../validation.ts";

describe("validation", () => {
  it("parses fenced JSON", () => {
    expect(parseJsonObjectOrArray('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("preserves invalid JSON instead of blocking the workflow", () => {
    expect(parseJsonObjectOrArray("not-json")).toMatchObject({
      raw_text: "not-json",
    });
  });

  it("validates extracted data", () => {
    expect(() =>
      validateExtractedData({
        document_title: "DYN2",
        language: "de",
        course: { title: "Dynamik", url: "https://moodle.example/course" },
        sources: [],
        sections: [],
        formulas: [],
        worked_examples: [],
        quiz_style_questions: [],
        warnings: [],
      }),
    ).not.toThrow();
  });

  it("returns a raw-output document shape when structured validation fails", () => {
    expect(validateExtractedData({ raw_text: "plain response" })).toMatchObject({
      document_title: "Moodle output",
      sections: [{ heading: "Raw response", summary: "plain response" }],
      warnings: expect.arrayContaining([
        "Structured validation failed; continuing with preserved raw output.",
      ]),
    });
  });

  it("validates the Study Buddy template shell with German text and math", async () => {
    const result = await validateTypst(
      [
        `#import "${STUDY_BUDDY_TEMPLATE_FILE}": *`,
        "",
        '#sb-document(title: "Formelsammlung", subtitle: "ÄÖÜ äöü ß", course: "Dynamik", body: [',
        "= Kräfte",
        '#sb-formula(name: "Newton", variables: ("F", "m", "a"), units: ("N", "kg", "m/s^2"))[$ F = m a $]',
        '#sb-diagram(caption: "Freikörperbild")[#sb-key-table((1fr, 1fr), (("Größe", "Wert"), ("Kraft", "$F$")))]',
        "])",
      ].join("\n"),
      [
        {
          relativePath: STUDY_BUDDY_TEMPLATE_FILE,
          content: STUDY_BUDDY_TYPST_TEMPLATE,
        },
      ],
    );

    expect(result).toEqual({ ok: true });
  });
});
