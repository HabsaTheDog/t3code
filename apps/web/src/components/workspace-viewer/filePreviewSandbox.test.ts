import { describe, expect, it } from "vitest";

import {
  htmlFilePreviewSandbox,
  INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX,
  RESTRICTED_HTML_FILE_PREVIEW_SANDBOX,
} from "./filePreviewSandbox";

describe("htmlFilePreviewSandbox", () => {
  it("enables local state and reset confirmation for cross-origin ticket previews", () => {
    expect(
      htmlFilePreviewSandbox(
        "http://127.0.0.1:13894/api/filesystem/preview/ticket",
        "http://127.0.0.1:5854/#/thread",
      ),
    ).toBe(INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX);
  });

  it("does not combine scripts and same-origin access on a same-origin preview", () => {
    expect(
      htmlFilePreviewSandbox(
        "https://study-buddy.example/api/filesystem/preview/ticket",
        "https://study-buddy.example/thread",
      ),
    ).toBe(RESTRICTED_HTML_FILE_PREVIEW_SANDBOX);
  });

  it("keeps unrelated sandbox capabilities disabled", () => {
    const capabilities = new Set(INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX.split(" "));

    expect(capabilities).toEqual(new Set(["allow-modals", "allow-same-origin", "allow-scripts"]));
    expect(capabilities).not.toContain("allow-forms");
    expect(capabilities).not.toContain("allow-popups");
    expect(capabilities).not.toContain("allow-top-navigation");
    expect(capabilities).not.toContain("allow-downloads");
  });
});
