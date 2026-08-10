import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PrivacyNotice } from "./PrivacyNotice";

describe("PrivacyNotice", () => {
  it("publishes the required controller, collection, retention, and withdrawal information", () => {
    const html = renderToStaticMarkup(<PrivacyNotice />);

    expect(html).toContain("Controller: Alvaro Schroll");
    expect(html).toContain("mailto:dev.habsa@gmail.com");
    expect(html).toContain("Usage analytics");
    expect(html).toContain("Session replay is disabled");
    expect(html).toContain("Conversation sharing");
    expect(html).toContain("private analytics service");
    expect(html).toContain("studybuddyanalytics.habsa.at");
    expect(html).toContain("for one year");
    expect(html).toContain("removed after 30 days");
    expect(html).toContain("Change your mind or ask about your data");
    expect(html).toContain("Settings → Privacy &amp; Data");
    expect(html).toContain("never goes back and shares earlier activity");
  });

  it("documents the sensitive data excluded from both categories", () => {
    const html = renderToStaticMarkup(<PrivacyNotice />);

    expect(html).toContain("what you type");
    expect(html).toContain("terminal output");
    expect(html).toContain("full file paths");
    expect(html).toContain("private instructions");
    expect(html).toContain("behind-the-scenes tool activity");
    expect(html).toContain("hidden reasoning");
    expect(html).toContain("passwords");
    expect(html).toContain("exact page addresses");
    expect(html).toContain("mouse movement");
    expect(html).toContain("scrolling");
  });
});
