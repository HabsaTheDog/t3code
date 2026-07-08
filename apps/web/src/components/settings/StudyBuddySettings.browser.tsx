import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const config = {
    exists: true,
    moodleUsername: "mr25b093",
    moodleDashboardUrl: "https://moodle.technikum-wien.at/my/",
    moodlePasswordConfigured: true,
    cisUsername: "mr25b093",
    cisUrl: "https://cis.technikum-wien.at/cis.php/",
    cisPasswordConfigured: true,
    calendarUrl: "https://cis.technikum-wien.at/calendar.ics",
    calendarUrlConfigured: true,
    quiz: {
      accessMode: "review-only" as const,
      minimumTimeLimitMinutes: 10,
      minimumAttemptsLeft: 2,
      fillConfidenceThreshold: 0.85,
    },
  };

  return {
    config,
    getStudyBuddyConfigurationMock: vi.fn(async () => config),
    updateStudyBuddyConfigurationMock: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => {
      if ("moodlePassword" in patch) config.moodlePasswordConfigured = true;
      if ("cisPassword" in patch) config.cisPasswordConfigured = true;
      if ("calendarUrl" in patch) {
        config.calendarUrl = String(patch.calendarUrl ?? "");
        config.calendarUrlConfigured = Boolean(config.calendarUrl);
      }
      return config;
    }),
    testStudyBuddyConnectionMock: vi.fn(async () => ({
      target: "moodle",
      ok: true,
      message: "Connection successful",
    })),
    captureMock: vi.fn(async () => undefined),
    reset() {
      this.getStudyBuddyConfigurationMock.mockClear();
      this.updateStudyBuddyConfigurationMock.mockClear();
      this.testStudyBuddyConnectionMock.mockClear();
      this.captureMock.mockClear();
      config.moodlePasswordConfigured = true;
      config.cisPasswordConfigured = true;
      config.calendarUrl = "https://cis.technikum-wien.at/calendar.ics";
      config.calendarUrlConfigured = true;
    },
  };
});

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    server: {
      getStudyBuddyConfiguration: harness.getStudyBuddyConfigurationMock,
      updateStudyBuddyConfiguration: harness.updateStudyBuddyConfigurationMock,
      testStudyBuddyConnection: harness.testStudyBuddyConnectionMock,
    },
  }),
}));

vi.mock("~/telemetry/runtime", () => ({
  registerTelemetrySecret: vi.fn(),
  telemetry: {
    capture: harness.captureMock,
  },
}));

import { StudyBuddySettingsPanel } from "./StudyBuddySettings";

describe("study buddy settings", () => {
  beforeEach(() => {
    harness.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a typed secret in place after autosave and lets you reveal it", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await expect.element(page.getByRole("heading", { name: "Study Buddy" })).toBeInTheDocument();
    await expect.element(page.getByText("Configured")).not.toBeInTheDocument();

    const password = page.getByRole("textbox", { name: "Moodle password" });
    await password.fill("correct horse battery staple");

    await vi.waitFor(() => {
      expect(harness.updateStudyBuddyConfigurationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({
            moodlePassword: expect.objectContaining({
              operation: "set",
              value: "correct horse battery staple",
            }),
          }),
        }),
      );
    });

    await expect.element(password).toHaveValue("correct horse battery staple");

    await page.getByRole("button", { name: "Reveal Moodle password" }).click();
    await expect.element(password).toHaveAttribute("type", "text");
    await expect.element(password).toHaveValue("correct horse battery staple");

    await mounted.unmount();
  });
});
