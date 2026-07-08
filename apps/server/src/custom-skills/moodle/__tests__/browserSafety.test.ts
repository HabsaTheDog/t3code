import { describe, expect, it } from "vitest";
import { assertSafeClick, extractLinksFromSnapshot, snapshotToText } from "../browserSafety.ts";

describe("browserSafety", () => {
  it("extracts refs and urls from agent-browser snapshots", () => {
    const links = extractLinksFromSnapshot(
      '- link "Course" [ref=e1, url=https://moodle.example/course/view.php?id=1]',
      {
        e1: { role: "link", name: "Course" },
      },
    );

    expect(links).toEqual([
      {
        ref: "e1",
        href: "https://moodle.example/course/view.php?id=1",
        label: "Course",
        role: "link",
      },
    ]);
  });

  it("blocks final submit controls", () => {
    expect(() => assertSafeClick("Submit all and finish")).toThrow(
      /Blocked final Moodle submission/,
    );
  });

  it("allows ordinary submit-like controls in open workflow mode", () => {
    expect(() => assertSafeClick("Submit")).not.toThrow();
  });

  it("converts snapshots to readable fallback text", () => {
    expect(
      snapshotToText(
        '- heading "Moodle Login" [level=1, ref=e11]\n  - textbox "Username" [ref=e12]\n  - link "Course" [ref=e1, url=https://moodle.example/course]',
      ),
    ).toContain('textbox "Username"');
  });

  it("allows safe Moodle navigation controls", () => {
    expect(() => assertSafeClick("Weiter")).not.toThrow();
  });
});
