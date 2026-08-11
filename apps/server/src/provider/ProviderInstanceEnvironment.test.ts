import { describe, expect, it } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  sanitizeProviderEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("removes Study Buddy portal credentials from inherited provider environments", () => {
    expect(
      sanitizeProviderEnvironment({
        PATH: "/bin",
        OPENAI_API_KEY: "provider-secret",
        MOODLE_USERNAME: "student",
        MOODLE_PASSWORD: "portal-secret",
        CIS_CALENDAR_URL: "https://calendar.example.test/private-feed",
        STUDY_BUDDY_SOURCES_JSON: "private-source-catalog",
        STUDY_BUDDY_SOURCE_MOODLE_2_SECRET: "source-secret",
      }),
    ).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "provider-secret",
    });
  });

  it("does not allow provider-instance overrides to reintroduce portal credentials", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "MOODLE_PASSWORD", value: "override", sensitive: true },
          { name: "CIS_USERNAME", value: "student", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "provider-secret", sensitive: true },
        ],
        { PATH: "/bin", MOODLE_PASSWORD: "inherited" },
      ),
    ).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-secret",
    });
  });
});
