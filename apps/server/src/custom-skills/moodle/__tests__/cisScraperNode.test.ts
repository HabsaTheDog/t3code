import { describe, expect, it } from "vitest";
import { createCisScraperNode } from "../nodes/cisScraperNode.ts";
import { initialSourceCoverage } from "../state.ts";

describe("cisScraperNode", () => {
  it("does nothing when no CIS URLs are configured", async () => {
    const node = createCisScraperNode({
      prompt: "test",
      moodleUrl: "https://moodle.example",
      outputPath: "/tmp/document.typ",
      runDir: "/tmp",
      maxDepth: 0,
      maxPages: 1,
      maxCisPages: 1,
      allowFileDownloads: false,
      baseUrl: "https://moodle.example",
      dashboardUrl: "https://moodle.example/my",
      cisUrls: [],
      cisBaseUrl: "https://cis.example",
      cisDashboardUrl: "https://cis.example",
      headless: true,
    });

    await expect(
      node({
        moodle_raw_text: "moodle text",
        source_coverage: initialSourceCoverage,
        extracted_data: {},
        final_document: "",
        error_log: null,
        retry_count: 0,
      }),
    ).resolves.toEqual({
      source_coverage: {
        ...initialSourceCoverage,
        cis: {
          status: "not_requested",
          detail: "No CIS URLs were configured.",
          urls: [],
          pages: 0,
        },
      },
    });
  });
});
