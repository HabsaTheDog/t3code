import { describe, expect, it } from "vite-plus/test";

import { sanitizeStudyBuddyHostEnvironment } from "./study-buddy-environment.ts";

describe("sanitizeStudyBuddyHostEnvironment", () => {
  it("keeps application configuration while removing portal credentials", () => {
    expect(
      sanitizeStudyBuddyHostEnvironment({
        PATH: "/bin",
        T3CODE_PORT_OFFSET: "120",
        STUDY_BUDDY_ROOT: "/workspace/study-buddy",
        MOODLE_USERNAME: "student",
        MOODLE_PASSWORD: "portal-secret",
        CIS_CALENDAR_URL: "https://calendar.example.test/private-feed",
        STUDY_BUDDY_SOURCES_JSON: "private-source-catalog",
        STUDY_BUDDY_SOURCE_CALENDAR_4_SECRET: "source-secret",
      }),
    ).toEqual({
      PATH: "/bin",
      T3CODE_PORT_OFFSET: "120",
      STUDY_BUDDY_ROOT: "/workspace/study-buddy",
    });
  });
});
