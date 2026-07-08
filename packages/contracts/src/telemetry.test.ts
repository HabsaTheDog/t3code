import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_CLIENT_SETTINGS, ClientSettingsSchema } from "./settings.ts";
import { StudyBuddyConfigurationPatch } from "./studyBuddy.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeStudyBuddyPatch = Schema.decodeUnknownSync(StudyBuddyConfigurationPatch);

describe("consent-aware client settings", () => {
  it("migrates existing settings with consent and onboarding disabled", () => {
    const decoded = decodeClientSettings({});
    expect(decoded.analyticsConsent).toBe("unset");
    expect(decoded.conversationConsent).toBe("unset");
    expect(decoded.installationId).toBe("");
    expect(decoded.onboardingStatus).toBe("not-started");
    expect(DEFAULT_CLIENT_SETTINGS.analyticsEnabledAt).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS.conversationEnabledAt).toBeNull();
  });

  it("accepts only an empty migration value or a UUID installation identifier", () => {
    expect(
      decodeClientSettings({ installationId: "00000000-0000-4000-8000-000000000001" })
        .installationId,
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => decodeClientSettings({ installationId: "email-or-user-id" })).toThrow();
  });
});

describe("Study Buddy configuration patches", () => {
  it("accepts password secret operations and plain calendar URLs", () => {
    expect(
      decodeStudyBuddyPatch({ moodlePassword: { operation: "unchanged" } }).moodlePassword,
    ).toEqual({
      operation: "unchanged",
    });
    expect(decodeStudyBuddyPatch({ cisPassword: { operation: "clear" } }).cisPassword).toEqual({
      operation: "clear",
    });
    expect(
      decodeStudyBuddyPatch({ calendarUrl: "https://example.test/calendar.ics" }).calendarUrl,
    ).toBe("https://example.test/calendar.ics");
    expect(() =>
      decodeStudyBuddyPatch({ moodlePassword: { operation: "set", value: "" } }),
    ).toThrow();
  });
});
