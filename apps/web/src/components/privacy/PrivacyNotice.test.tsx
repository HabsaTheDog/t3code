import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PrivacyNotice } from "./PrivacyNotice";

describe("PrivacyNotice", () => {
  it("publishes the required controller, collection, retention, and withdrawal information", () => {
    const html = renderToStaticMarkup(<PrivacyNotice />);

    expect(html).toContain("Controller: Alvaro Schroll");
    expect(html).toContain("mailto:dev.habsa@gmail.com");
    expect(html).toContain("Usage analytics and click heatmaps");
    expect(html).toContain("Session replay is disabled");
    expect(html).toContain("Conversation sharing");
    expect(html).toContain("self-hosted PostHog deployment");
    expect(html).toContain("studybuddyanalytics.habsa.at");
    expect(html).toContain("retained for one year");
    expect(html).toContain("expire after 30 days");
    expect(html).toContain("Withdrawal and data-subject requests");
    expect(html).toContain("Settings → Privacy &amp; Data");
    expect(html).toContain("never backfills pre-consent data");
  });

  it("documents the sensitive data excluded from both categories", () => {
    const html = renderToStaticMarkup(<PrivacyNotice />);

    expect(html).toContain("Prompt and transcript text");
    expect(html).toContain("terminal content");
    expect(html).toContain("filesystem paths");
    expect(html).toContain("System/developer instructions");
    expect(html).toContain("tool names/arguments/results");
    expect(html).toContain("hidden reasoning");
    expect(html).toContain("known credentials");
  });
});
