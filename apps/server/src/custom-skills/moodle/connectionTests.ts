// @effect-diagnostics globalDate:off
import {
  StudyBuddyConfigurationError,
  type StudyBuddyConnectionTarget,
  type StudyBuddyConnectionTestResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { chromium } from "playwright";
import type { ServerConfigShape } from "../../config.ts";
import { createBrowserLoginConfig, ensureLoggedIn } from "./browserAuth.ts";
import { fetchCalendarText, normalizeCalendarUrl, parseCalendarEvents } from "./calendarAdapter.ts";
import {
  readStoredStudyBuddyConfiguration,
  type StoredStudyBuddyConfiguration,
} from "./studyBuddyConfig.ts";

interface ConnectionTestPage {}

interface ConnectionTestBrowser {
  readonly newPage: () => Promise<ConnectionTestPage>;
  readonly close: () => Promise<void>;
}

interface ConnectionTestDependencies {
  readonly readConfiguration: (config: ServerConfigShape) => Promise<StoredStudyBuddyConfiguration>;
  readonly fetchCalendar: (url: string) => Promise<string>;
  readonly parseCalendar: (text: string) => unknown;
  readonly launchBrowser: () => Promise<ConnectionTestBrowser>;
  readonly ensureLogin: (
    page: ConnectionTestPage,
    config: ReturnType<typeof createBrowserLoginConfig>,
  ) => Promise<void>;
  readonly now: () => string;
}

const liveDependencies: ConnectionTestDependencies = {
  readConfiguration: readStoredStudyBuddyConfiguration,
  fetchCalendar: fetchCalendarText,
  parseCalendar: parseCalendarEvents,
  launchBrowser: () => chromium.launch({ headless: true }),
  ensureLogin: (page, config) => ensureLoggedIn(page as never, config),
  now: () => new Date().toISOString(),
};

export const testStudyBuddyConnection = (
  config: ServerConfigShape,
  target: StudyBuddyConnectionTarget,
  dependencyOverrides: Partial<ConnectionTestDependencies> = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const dependencies = { ...liveDependencies, ...dependencyOverrides };
      const stored = await dependencies.readConfiguration(config);
      const checkedAt = dependencies.now();
      try {
        if (target === "calendar") {
          const url = stored.values.CIS_CALENDAR_URL;
          if (!url) {
            return failure(target, "not-configured", "Calendar URL is not configured.", checkedAt);
          }
          const text = await dependencies.fetchCalendar(normalizeCalendarUrl(url));
          dependencies.parseCalendar(text);
          return success(target, "Calendar HTTPS fetch and iCalendar parse succeeded.", checkedAt);
        }

        const isMoodle = target === "moodle";
        const configuredUrl = isMoodle
          ? stored.values.MOODLE_DASHBOARD_URL || "https://moodle.technikum-wien.at/my/"
          : firstUrl(stored.values.CIS_URLS) || "https://cis.technikum-wien.at/cis.php/";
        const targetUrl = isMoodle
          ? moodleDashboardUrl(configuredUrl)
          : sanitizedUrl(configuredUrl);
        const username = isMoodle
          ? stored.values.MOODLE_USERNAME
          : stored.values.CIS_USERNAME || stored.values.MOODLE_USERNAME;
        const password = isMoodle
          ? stored.values.MOODLE_PASSWORD
          : stored.values.CIS_PASSWORD || stored.values.MOODLE_PASSWORD;
        if (!username || !password) {
          return failure(
            target,
            "credentials-not-configured",
            `${label(target)} credentials are not configured.`,
            checkedAt,
          );
        }

        const browser = await dependencies.launchBrowser();
        try {
          const page = await browser.newPage();
          await dependencies.ensureLogin(
            page,
            createBrowserLoginConfig({
              serviceName: label(target),
              targetUrl,
              username,
              password,
            }),
          );
        } finally {
          await browser.close();
        }
        return success(
          target,
          `${label(target)} login and page reachability succeeded.`,
          checkedAt,
        );
      } catch (error) {
        return failure(target, diagnosticCode(error), safeMessage(error, target), checkedAt);
      }
    },
    catch: () =>
      new StudyBuddyConfigurationError({
        message: "Failed to run Study Buddy connection test.",
      }),
  });

function moodleDashboardUrl(value: string): string {
  const parsed = new URL(sanitizedUrl(value));
  parsed.pathname = "/my/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function sanitizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  const sensitiveKeys = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|password|passwd|api[_-]?key|auth|credential)/i.test(key)) {
      sensitiveKeys.add(key);
    }
  }
  for (const key of sensitiveKeys) parsed.searchParams.delete(key);
  return parsed.toString();
}

function firstUrl(value: string | undefined): string | null {
  return value?.split(/[\s,]+/).find(Boolean) ?? null;
}

function label(target: StudyBuddyConnectionTarget): string {
  return target === "moodle" ? "Moodle" : target === "cis" ? "CIS" : "Calendar";
}

function success(
  target: StudyBuddyConnectionTarget,
  message: string,
  checkedAt: string,
): StudyBuddyConnectionTestResult {
  return { target, status: "success", code: "ok", message, checkedAt };
}

function failure(
  target: StudyBuddyConnectionTarget,
  code: StudyBuddyConnectionTestResult["code"],
  message: string,
  checkedAt: string,
): StudyBuddyConnectionTestResult {
  return { target, status: "failure", code, message, checkedAt };
}

function diagnosticCode(error: unknown): StudyBuddyConnectionTestResult["code"] {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("invalid") || message.includes("login")) return "authentication-failed";
  if (message.includes("icalendar") || message.includes("vcalendar")) return "invalid-calendar";
  return "unreachable";
}

function safeMessage(error: unknown, target: StudyBuddyConnectionTarget): string {
  const raw =
    error instanceof Error && error.message.trim()
      ? error.message
      : `${label(target)} connection test failed.`;
  return raw
    .replace(/(?:https?|webcal):\/\/\S+/gi, "[redacted URL]")
    .replace(/(password|token|key|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}
