import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const config = {
    exists: true,
    moodleUsername: "student123",
    moodleDashboardUrl: "https://moodle.technikum-wien.at/my/",
    moodlePasswordConfigured: true,
    cisUsername: "student123",
    cisUrl: "https://cis.technikum-wien.at/cis.php/",
    cisPasswordConfigured: true,
    calendarUrl: "https://calendar.example/my-calendar.ics",
    calendarUrlConfigured: true,
    quiz: {
      accessMode: "review-only" as const,
      minimumTimeLimitMinutes: 10,
      minimumAttemptsLeft: 2,
      fillConfidenceThreshold: 0.85,
    },
  };
  const settings: {
    studyBuddyExecutionProfile: "auto" | "fast" | "balanced" | "quality";
    personalityPrompt: string;
  } = {
    studyBuddyExecutionProfile: "balanced",
    personalityPrompt: "Be direct and call me Alex.",
  };

  return {
    config,
    settings,
    updateSettingsMock: vi.fn(
      (patch: { studyBuddyExecutionProfile?: string; personalityPrompt?: string }) => {
        if (patch.studyBuddyExecutionProfile) {
          settings.studyBuddyExecutionProfile = patch.studyBuddyExecutionProfile as
            | "auto"
            | "fast"
            | "balanced"
            | "quality";
        }
        if (patch.personalityPrompt !== undefined) {
          settings.personalityPrompt = patch.personalityPrompt;
        }
      },
    ),
    getStudyBuddyConfigurationMock: vi.fn(async () => config),
    updateStudyBuddyConfigurationMock: vi.fn(
      async ({ patch }: { patch: Record<string, unknown> }) => {
        if ("moodlePassword" in patch) config.moodlePasswordConfigured = true;
        if ("cisPassword" in patch) config.cisPasswordConfigured = true;
        if (typeof patch.calendarUrl === "string") config.calendarUrl = patch.calendarUrl;
        return config;
      },
    ),
    testStudyBuddyConnectionMock: vi.fn(async () => ({
      target: "moodle",
      status: "success" as const,
      code: "ok" as const,
      message: "Connection successful",
      checkedAt: new Date().toISOString(),
    })),
    captureMock: vi.fn(async () => undefined),
    reset() {
      this.getStudyBuddyConfigurationMock.mockClear();
      this.updateStudyBuddyConfigurationMock.mockClear();
      this.testStudyBuddyConnectionMock.mockClear();
      this.captureMock.mockClear();
      this.updateSettingsMock.mockClear();
      this.settings.studyBuddyExecutionProfile = "balanced";
      this.settings.personalityPrompt = "Be direct and call me Alex.";
      config.moodlePasswordConfigured = true;
      config.cisPasswordConfigured = true;
      config.calendarUrl = "https://calendar.example/my-calendar.ics";
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

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (selector?: (settings: typeof harness.settings) => unknown) =>
    selector ? selector(harness.settings) : harness.settings,
  useUpdateSettings: () => ({
    updateSettings: harness.updateSettingsMock,
  }),
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
    const password = page.getByRole("textbox", { name: "Moodle password" });
    await expect
      .element(password)
      .toHaveAttribute("placeholder", "Password saved — enter to replace");
    await expect
      .element(page.getByRole("textbox", { name: "Calendar URL" }))
      .toHaveValue("https://calendar.example/my-calendar.ics");
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

  it("shows setup and personality controls in Study Buddy settings", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await expect.element(page.getByRole("button", { name: "Run setup again" })).toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Agent personality instructions"))
      .toHaveValue("Be direct and call me Alex.");
    await expect
      .element(
        page.getByText("Saved when you leave the field. Applied when a new agent session starts."),
      )
      .toBeInTheDocument();

    await mounted.unmount();
  });

  it("places connection checks beside each source and shows clear result feedback", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await expect.element(page.getByText("Connection checks")).not.toBeInTheDocument();
    const moodleCheck = page.getByRole("button", { name: "Test moodle connection" });
    const cisCheck = page.getByRole("button", { name: "Test CIS connection" });
    const calendarCheck = page.getByRole("button", { name: "Test calendar connection" });
    await expect.element(moodleCheck).toBeInTheDocument();
    await expect.element(cisCheck).toBeInTheDocument();
    await expect.element(calendarCheck).toBeInTheDocument();

    await moodleCheck.click();
    await expect.element(moodleCheck).toHaveTextContent("Connected");

    await mounted.unmount();
  });

  it("keeps execution profiles out of the connection settings panel", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await expect
      .element(page.getByRole("combobox", { name: "Study Buddy execution profile" }))
      .not.toBeInTheDocument();

    await mounted.unmount();
  });

  it("autosaves without showing a redundant saved status", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await expect
      .element(page.getByRole("button", { name: "Reload Study Buddy settings" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Saved", { exact: true })).not.toBeInTheDocument();

    await mounted.unmount();
  });
});
