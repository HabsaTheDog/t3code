import "../../index.css";

import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const {
  captureMock,
  diagnosticsMock,
  durableUpdate,
  flushMock,
  getDurableState,
  getStudyBuddyConfigurationMock,
  updateStudyBuddyConfigurationMock,
  testStudyBuddyConnectionMock,
  randomUuidMock,
  setDurableFailure,
  settings,
  updateSettingsMock,
} = vi.hoisted(() => {
  const mutableSettings = {
    installationId: "",
    analyticsConsent: "unset" as "unset" | "accepted" | "rejected",
    conversationConsent: "unset" as "unset" | "accepted" | "rejected",
    consentVersion: 0,
    consentUpdatedAt: null as string | null,
    analyticsEnabledAt: null as string | null,
    conversationEnabledAt: null as string | null,
    onboardingVersion: 0,
    onboardingStatus: "not-started" as "not-started" | "in-progress" | "completed",
    onboardingCurrentStep: null as string | null,
    studyBuddyConnectionChecks: {} as Record<string, unknown>,
    providers: {},
    providerInstances: {},
  };
  const getDurableState = () => {
    const scope = globalThis as typeof globalThis & {
      __studyBuddyPrivacyBrowserDurableState?: {
        calls: Array<Partial<typeof mutableSettings>>;
        fail: boolean;
      };
    };
    scope.__studyBuddyPrivacyBrowserDurableState ??= { calls: [], fail: false };
    return scope.__studyBuddyPrivacyBrowserDurableState;
  };
  const studyBuddyConfiguration = {
    moodleUsername: "",
    moodlePasswordConfigured: false,
    cisUsername: "",
    cisPasswordConfigured: false,
    moodleDashboardUrl: "",
    cisUrl: "",
    calendarUrl: "",
    calendarUrlConfigured: false,
    quiz: {
      accessMode: "review-only",
    },
  };
  return {
    captureMock: vi.fn(async () => undefined),
    diagnosticsMock: vi.fn(async () => ({
      queuedBytes: 0,
      queuedItems: 0,
      oldestItemAt: null,
      lastSuccessfulSyncAt: null,
      droppedCount: 0,
      lastError: null,
    })),
    durableUpdate: async (patch: Partial<typeof mutableSettings>) => {
      const state = getDurableState();
      state.calls.push(patch);
      if (state.fail) throw new Error("storage unavailable");
      Object.assign(mutableSettings, patch);
      return mutableSettings;
    },
    flushMock: vi.fn(async () => undefined),
    getStudyBuddyConfigurationMock: vi.fn(async () => studyBuddyConfiguration),
    updateStudyBuddyConfigurationMock: vi.fn(
      async ({ patch }: { patch: Record<string, unknown> }) => {
        if ("moodleUsername" in patch)
          studyBuddyConfiguration.moodleUsername = String(patch.moodleUsername ?? "");
        if ("cisUsername" in patch)
          studyBuddyConfiguration.cisUsername = String(patch.cisUsername ?? "");
        if ("moodleDashboardUrl" in patch)
          studyBuddyConfiguration.moodleDashboardUrl = String(patch.moodleDashboardUrl ?? "");
        if ("cisUrl" in patch) studyBuddyConfiguration.cisUrl = String(patch.cisUrl ?? "");
        if ("quiz" in patch && patch.quiz && typeof patch.quiz === "object") {
          const nextQuiz = patch.quiz as { accessMode?: string };
          if (nextQuiz.accessMode) studyBuddyConfiguration.quiz.accessMode = nextQuiz.accessMode;
        }
        if ("calendarUrlSecret" in patch) {
          const secret = patch.calendarUrlSecret as { operation?: string };
          studyBuddyConfiguration.calendarUrlConfigured = secret.operation !== "clear";
        }
        if ("moodlePassword" in patch) studyBuddyConfiguration.moodlePasswordConfigured = true;
        if ("cisPassword" in patch) studyBuddyConfiguration.cisPasswordConfigured = true;
        return studyBuddyConfiguration;
      },
    ),
    testStudyBuddyConnectionMock: vi.fn(async () => ({
      target: "moodle",
      message: "Connection successful",
      status: "success",
      code: "ok",
      checkedAt: "2026-01-01T00:00:00.000Z",
    })),
    randomUuidMock: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
    getDurableState,
    setDurableFailure: (value: boolean) => {
      getDurableState().fail = value;
    },
    settings: mutableSettings,
    updateSettingsMock: vi.fn((patch: Partial<typeof mutableSettings>) => {
      Object.assign(mutableSettings, patch);
    }),
  };
});

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings,
  useClientSettingsHydrated: () => true,
  useSettings: (selector?: (value: typeof settings) => unknown) =>
    selector ? selector(settings) : settings,
  useUpdateSettings: () => ({
    updateSettings: updateSettingsMock,
    updateClientSettingsDurably: durableUpdate,
  }),
  __resetClientSettingsPersistenceForTests: vi.fn(),
}));

vi.mock("~/hostedPairing", () => ({
  isHostedStaticApp: () => false,
}));

vi.mock("~/rpc/serverState", () => ({
  getServerConfig: () => null,
  useServerProviders: () => [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "0.144.3",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-13T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ],
}));

vi.mock("~/localApi", () => {
  const api = {
    server: {
      getStudyBuddyConfiguration: getStudyBuddyConfigurationMock,
      updateStudyBuddyConfiguration: updateStudyBuddyConfigurationMock,
      testStudyBuddyConnection: testStudyBuddyConnectionMock,
      getProviderSetupCapabilities: async () => [],
      refreshProviders: async () => ({}),
    },
  };
  return {
    ensureLocalApi: () => api,
    readLocalApi: () => api,
  };
});

vi.mock("~/telemetry/runtime", () => ({
  registerTelemetrySecret: vi.fn(),
  telemetry: {
    capture: captureMock,
    diagnostics: diagnosticsMock,
    flush: flushMock,
    updateConsent: vi.fn(async () => undefined),
  },
  telemetryProductionConfigured: false,
}));

vi.mock("~/telemetry/types", () => ({
  systemTelemetryRandom: {
    uuid: randomUuidMock,
    random: () => 0.5,
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      to,
      onClick,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
      <a
        href={to}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          window.history.pushState({}, "", to);
        }}
        {...props}
      >
        {children}
      </a>
    ),
  };
});

import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { PrivacySettingsPanel } from "../settings/PrivacySettings";
import { SetupGate } from "../../setup/SetupWizard";

function resetSettings(patch: Partial<typeof settings> = {}): void {
  Object.assign(settings, {
    installationId: "",
    analyticsConsent: "unset",
    conversationConsent: "unset",
    consentVersion: 0,
    consentUpdatedAt: null,
    analyticsEnabledAt: null,
    conversationEnabledAt: null,
    onboardingVersion: 0,
    onboardingStatus: "not-started",
    onboardingCurrentStep: null,
    studyBuddyConnectionChecks: {},
    providers: {},
    providerInstances: {},
    ...patch,
  });
}

async function renderSetup() {
  return render(
    <SetupGate>
      <div>Application content</div>
    </SetupGate>,
  );
}

describe.sequential("first-run privacy and setup", () => {
  beforeEach(() => {
    resetSettings();
    updateSettingsMock.mockClear();
    randomUuidMock.mockClear();
    captureMock.mockClear();
    getStudyBuddyConfigurationMock.mockClear();
    updateStudyBuddyConfigurationMock.mockClear();
    testStudyBuddyConnectionMock.mockClear();
    getDurableState().calls.length = 0;
    setDurableFailure(false);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
  });

  it.sequential("shows a compact first screen with direct notice access", async () => {
    const screen = await renderSetup();

    await expect
      .element(page.getByRole("heading", { name: "Privacy", level: 1 }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Read full privacy notice" }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Allow all" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Reject all" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(randomUuidMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it.sequential("lets the user approve only one category before continuing", async () => {
    const screen = await renderSetup();

    await page.getByRole("checkbox", { name: "Usage analytics" }).click();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue" }).click();

    await vi.waitFor(() => {
      expect(getDurableState().calls).toContainEqual(
        expect.objectContaining({
          analyticsConsent: "accepted",
          conversationConsent: "rejected",
          consentVersion: 1,
          installationId: "00000000-0000-4000-8000-000000000001",
        }),
      );
    });
    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();

    await screen.unmount();
  });

  it.sequential("opens the privacy notice page from the setup screen", async () => {
    const screen = await renderSetup();

    await page.getByRole("link", { name: "Read full privacy notice" }).click();

    expect(window.location.pathname).toBe("/privacy");
    await screen.unmount();
  });

  it.sequential("selects both categories with one button", async () => {
    const screen = await renderSetup();

    await page.getByRole("button", { name: "Allow all" }).click();

    await vi.waitFor(() => {
      expect(getDurableState().calls).toContainEqual(
        expect.objectContaining({
          analyticsConsent: "accepted",
          conversationConsent: "accepted",
          consentVersion: 1,
          installationId: "00000000-0000-4000-8000-000000000001",
        }),
      );
    });
    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();

    await screen.unmount();
  });

  it.sequential("checks Moodle inline and only advances when continuing", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "moodle",
    });
    const screen = await renderSetup();

    await expect
      .element(page.getByRole("heading", { name: "Moodle", level: 1 }))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText("Moodle link")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Moodle login")).toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Moodle password", { exact: true }))
      .toBeInTheDocument();

    await page.getByLabelText("Moodle link").fill("https://moodle.example/");
    await page.getByLabelText("Moodle login").fill("student123");
    await page.getByLabelText("Moodle password", { exact: true }).fill("secret");
    await page.getByRole("button", { name: "Check" }).click();

    await vi.waitFor(() => {
      expect(updateStudyBuddyConfigurationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({
            moodleUsername: "student123",
            moodleDashboardUrl: "https://moodle.example/",
            moodlePassword: expect.objectContaining({
              operation: "set",
              value: "secret",
            }),
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(testStudyBuddyConnectionMock).toHaveBeenCalledWith({
        target: "moodle",
      });
      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          studyBuddyConnectionChecks: expect.objectContaining({
            moodle: expect.objectContaining({
              status: "success",
              message: "Connection successful",
            }),
          }),
        }),
      );
    });
    await expect.element(page.getByText("Connection successful")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Moodle password", { exact: true })).toHaveValue("");
    await expect
      .element(page.getByRole("heading", { name: "Moodle", level: 1 }))
      .toBeInTheDocument();

    testStudyBuddyConnectionMock.mockClear();
    await page.getByRole("button", { name: "Continue" }).click();

    await vi.waitFor(() => {
      expect(updateStudyBuddyConfigurationMock).toHaveBeenCalledTimes(2);
    });
    expect(testStudyBuddyConnectionMock).not.toHaveBeenCalled();
    await expect.element(page.getByRole("heading", { name: "CIS", level: 1 })).toBeInTheDocument();

    await screen.unmount();
  });

  it.sequential("restores the last passed connection check when returning to a setup step", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "moodle",
      studyBuddyConnectionChecks: {
        moodle: {
          target: "moodle",
          message: "Moodle login and page reachability succeeded.",
          status: "success",
          code: "ok",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const screen = await renderSetup();

    await expect
      .element(page.getByText("Moodle login and page reachability succeeded."))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText("Connection check passed")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Moodle", level: 1 }))
      .toBeInTheDocument();
    expect(testStudyBuddyConnectionMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it.sequential("does not advance setup when durable progress persistence fails", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "provider",
    });
    setDurableFailure(true);
    const screen = await renderSetup();

    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();
    await expect
      .element(
        page.getByText("Setup progress could not be saved locally. Retry before continuing."),
      )
      .toBeInTheDocument();
    await screen.unmount();
  });

  it.sequential("skips privacy and continues to the next setup step", async () => {
    const first = await renderSetup();

    await page.getByRole("button", { name: "Skip" }).click();
    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(getDurableState().calls).toContainEqual(
        expect.objectContaining({
          analyticsConsent: "rejected",
          conversationConsent: "rejected",
          consentVersion: 1,
        }),
      );
      expect(getDurableState().calls).toContainEqual({
        onboardingStatus: "in-progress",
        onboardingCurrentStep: "provider",
      });
    });
    expect(settings.analyticsConsent).toBe("rejected");
    expect(settings.conversationConsent).toBe("rejected");
    await first.unmount();

    const second = await renderSetup();
    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();
    await second.unmount();
  });

  it.sequential("resumes, completes required Codex setup, and persists completion", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "provider",
    });
    const resumed = await renderSetup();

    await expect.element(page.getByText("Set up Codex")).toBeInTheDocument();
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() => {
      expect(getDurableState().calls).toContainEqual({
        onboardingStatus: "in-progress",
        onboardingCurrentStep: "moodle",
      });
    });
    await expect
      .element(page.getByRole("heading", { name: "Moodle", level: 1 }))
      .toBeInTheDocument();
    await resumed.unmount();

    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "quiz-safety",
    });
    const quizSafety = await renderSetup();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await vi.waitFor(() => {
      expect(getDurableState().calls).toContainEqual({
        onboardingVersion: 1,
        onboardingStatus: "completed",
        onboardingCurrentStep: null,
      });
    });
    await quizSafety.unmount();

    const completed = await renderSetup();
    await expect.element(page.getByText("Application content")).toBeInTheDocument();
    await completed.unmount();
  });

  it.sequential("keeps the setup header aligned and lists quiz safety choices vertically", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingStatus: "in-progress",
      onboardingCurrentStep: "quiz-safety",
    });
    const screen = await renderSetup();

    await expect
      .element(page.getByRole("heading", { name: "Quiz safety", level: 1 }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Step 6 of 6")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Quiz safety is non-negotiable", level: 2 }))
      .toBeInTheDocument();

    await vi.waitFor(() => {
      const header = document.querySelector<HTMLElement>('[data-setup-header="true"]');
      const stepIndicator = header?.querySelector<HTMLElement>("p");
      const introHeading = document.querySelector<HTMLElement>('[data-setup-intro-heading="true"]');
      const options = Array.from(
        document.querySelectorAll<HTMLElement>("[data-quiz-access-option]"),
      );

      expect(header).toBeTruthy();
      expect(stepIndicator).toBeTruthy();
      expect(introHeading).toBeTruthy();
      expect(options).toHaveLength(4);

      const headerRect = header!.getBoundingClientRect();
      const stepRect = stepIndicator!.getBoundingClientRect();
      expect(
        Math.abs(stepRect.left + stepRect.width / 2 - (headerRect.left + headerRect.width / 2)),
      ).toBeLessThanOrEqual(1.5);

      const introChildren = Array.from(introHeading!.children) as HTMLElement[];
      expect(introChildren).toHaveLength(2);
      const introIconRect = introChildren[0]!.getBoundingClientRect();
      const introTitleRect = introChildren[1]!.querySelector("h2")!.getBoundingClientRect();
      expect(introTitleRect.top).toBeGreaterThanOrEqual(introIconRect.top);
      expect(introTitleRect.top - introIconRect.top).toBeLessThanOrEqual(8);

      const optionRects = options.map((option) => option.getBoundingClientRect());
      for (let index = 1; index < optionRects.length; index += 1) {
        expect(optionRects[index]!.top).toBeGreaterThan(optionRects[index - 1]!.bottom);
        expect(Math.abs(optionRects[index]!.width - optionRects[0]!.width)).toBeLessThanOrEqual(1);
      }
    });

    await screen.unmount();
  });

  it.sequential("honors the developer setup URL override for completed installations", async () => {
    resetSettings({
      analyticsConsent: "rejected",
      conversationConsent: "rejected",
      consentVersion: 1,
      onboardingVersion: 1,
      onboardingStatus: "completed",
    });
    window.history.replaceState({}, "", "/?setup=1");

    const screen = await renderSetup();

    await expect
      .element(page.getByRole("heading", { name: "Privacy", level: 1 }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Application content")).not.toBeInTheDocument();
    await screen.unmount();
  });
});

describe.sequential("privacy settings and public notice", () => {
  beforeEach(() => {
    resetSettings({
      installationId: "install-existing",
      analyticsConsent: "accepted",
      analyticsEnabledAt: "2026-01-01T00:00:00.000Z",
      conversationConsent: "rejected",
    });
    updateSettingsMock.mockClear();
    getDurableState().calls.length = 0;
    setDurableFailure(false);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.sequential("changes analytics and conversation consent independently", async () => {
    const screen = await render(<PrivacySettingsPanel />);

    await page.getByRole("switch", { name: "Share completed conversations" }).click();
    await vi.waitFor(() => {
      expect(getDurableState().calls.at(-1)).toEqual(
        expect.objectContaining({
          conversationConsent: "accepted",
        }),
      );
    });
    expect(getDurableState().calls.at(-1)).not.toHaveProperty("analyticsConsent");

    await page.getByRole("switch", { name: "Share usage analytics" }).click();
    await vi.waitFor(() => {
      expect(getDurableState().calls.at(-1)).toEqual(
        expect.objectContaining({
          analyticsConsent: "rejected",
          analyticsEnabledAt: null,
        }),
      );
    });
    expect(getDurableState().calls.at(-1)).not.toHaveProperty("conversationConsent");

    await screen.unmount();
  });

  it.sequential("publishes the controller, collection, retention, and withdrawal details", async () => {
    const screen = await render(<PrivacyNotice />);

    await expect.element(page.getByText("Controller: Alvaro Schroll")).toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "dev.habsa@gmail.com" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Usage analytics and click heatmaps" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Conversation sharing" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Withdrawal and data-subject requests" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/self-hosted PostHog deployment at studybuddyanalytics\.habsa\.at/))
      .toBeInTheDocument();
    await expect.element(page.getByText(/retained for one year/)).toBeInTheDocument();
    await expect.element(page.getByText(/expire after 30 days/)).toBeInTheDocument();

    await screen.unmount();
  });
});
