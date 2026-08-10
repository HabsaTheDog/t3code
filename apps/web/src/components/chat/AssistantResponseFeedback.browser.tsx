import "../../index.css";

import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  submitResponseFeedback: vi.fn(async (input: { note?: string }) => ({
    ratingCaptured: !input.note,
    noteCaptured: Boolean(input.note),
  })),
}));

import { AssistantResponseFeedback } from "./AssistantResponseFeedback";

describe("AssistantResponseFeedback", () => {
  beforeEach(() => {
    window.localStorage.clear();
    harness.submitResponseFeedback.mockClear();
  });

  it("keeps both ratings visible and opens Optional Feedback beside them", async () => {
    await render(
      <AssistantResponseFeedback
        threadId="thread-1"
        turnId="turn-1"
        submitFeedback={harness.submitResponseFeedback}
      />,
    );

    const positive = page.getByRole("button", { name: "Helpful response", exact: true });
    const negative = page.getByRole("button", { name: "Unhelpful response", exact: true });
    await expect.element(positive).toBeVisible();
    await expect.element(negative).toBeVisible();

    await negative.click();
    await expect.element(negative).toHaveAttribute("aria-pressed", "true");
    const noteField = page.getByLabelText("Optional Feedback");
    await expect.element(noteField).toBeVisible();
    await expect.element(noteField).toHaveAttribute("placeholder", "Optional Feedback");
    await expect.element(noteField).toHaveAttribute("maxlength", "4000");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Unhelpful response");
    const noteElement = (await noteField.element()) as HTMLTextAreaElement;
    const singleLineHeight = noteElement.offsetHeight;
    await noteField.fill("A longer feedback sentence that wraps naturally. ".repeat(8));
    expect(noteElement.offsetHeight).toBeGreaterThan(singleLineHeight);
    expect(window.localStorage.getItem("study-buddy:response-feedback:thread-1:turn-1")).toContain(
      '"rating":"negative"',
    );
  });

  it("submits and locally remembers the optional note", async () => {
    await render(
      <AssistantResponseFeedback
        threadId="thread-1"
        turnId="turn-1"
        submitFeedback={harness.submitResponseFeedback}
      />,
    );
    await page.getByRole("button", { name: "Helpful response", exact: true }).click();
    await page.getByLabelText("Optional Feedback").fill("Clear and useful.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("Feedback sent");

    expect(window.localStorage.getItem("study-buddy:response-feedback:thread-1:turn-1")).toContain(
      "Clear and useful.",
    );
  });
});
