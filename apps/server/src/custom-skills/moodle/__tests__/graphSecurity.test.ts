import { describe, expect, it } from "vite-plus/test";

import { sanitizeGraphState } from "../graph.ts";
import { initialAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

describe("graph output credential boundary", () => {
  it("removes configured credentials from every persisted/model-visible state field", () => {
    const password = "graph-canary-password";
    const calendar = "https://calendar.example/graph-canary-token.ics";
    const state = {
      ...initialAgentState,
      moodle_raw_text: `page echoed ${password}`,
      extracted_data: { note: password, calendar },
      final_document: `Document ${password}`,
      error_log: `Failure at ${calendar}`,
      source_coverage: {
        ...initialAgentState.source_coverage,
        moodle: {
          status: "failed" as const,
          detail: password,
          urls: [`https://school.example/?token=${password}`],
          pages: 0,
        },
      },
    };
    const sanitized = sanitizeGraphState(state, {
      password,
      calendarUrl: calendar,
    } as MoodleRuntimeConfig);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(calendar);
    expect(serialized).toContain("REDACTED");
  });
});
