import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ServerConfigShape } from "../../../config.ts";
import { testStudyBuddyConnection } from "../connectionTests.ts";
import type { StoredStudyBuddyConfiguration } from "../studyBuddyConfig.ts";
import type { BrowserLoginConfig } from "../browserAuth.ts";

const checkedAt = "2026-06-28T12:00:00.000Z";
const config = { cwd: "/tmp/study-buddy" } as ServerConfigShape;

function stored(values: Readonly<Record<string, string>>): StoredStudyBuddyConfiguration {
  return {
    envPath: "/tmp/study-buddy/.env.local",
    exists: true,
    raw: "",
    values,
  };
}

const browser = {
  newPage: vi.fn(async () => ({})),
  close: vi.fn(async () => undefined),
};

const loginCases: ReadonlyArray<{
  readonly target: "moodle" | "cis";
  readonly values: Readonly<Record<string, string>>;
  readonly expectedUrl: string;
}> = [
  {
    target: "moodle",
    values: {
      MOODLE_USERNAME: "student",
      MOODLE_PASSWORD: "moodle-secret",
      MOODLE_DASHBOARD_URL: "https://user:pass@moodle.example/course?token=private",
    },
    expectedUrl: "https://moodle.example/my/",
  },
  {
    target: "cis",
    values: {
      CIS_USERNAME: "student",
      CIS_PASSWORD: "cis-secret",
      CIS_URLS: "https://user:pass@cis.example/?token=private",
    },
    expectedUrl: "https://cis.example/cis.php/",
  },
];

describe("Study Buddy connection tests", () => {
  it.each(loginCases)(
    "reports a typed $target login success without forwarding URL credentials",
    async (input) => {
      const ensureLogin = vi.fn(
        async (_page: unknown, _loginConfig: BrowserLoginConfig) => undefined,
      );
      const result = await Effect.runPromise(
        testStudyBuddyConnection(config, input.target, {
          readConfiguration: async () => stored(input.values),
          launchBrowser: async () => browser,
          ensureLogin,
          now: () => checkedAt,
        }),
      );

      expect(result).toEqual({
        target: input.target,
        status: "success",
        code: "ok",
        message: `${input.target === "moodle" ? "Moodle" : "CIS"} is connected.`,
        checkedAt,
      });
      const loginConfig = ensureLogin.mock.calls[0]?.[1];
      expect(loginConfig).toMatchObject({
        targetUrl: input.expectedUrl,
        requireCredentialSubmission: input.target === "moodle",
      });
      if (input.target === "cis") {
        expect(browser.newPage).toHaveBeenLastCalledWith({
          httpCredentials: { username: "student", password: "cis-secret" },
        });
      } else {
        expect(browser.newPage).toHaveBeenLastCalledWith();
      }
      expect(loginConfig?.resolveUsername()).toBe("student");
      expect(loginConfig?.allowedOrigins).toEqual(new Set([new URL(input.expectedUrl).origin]));
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(browser.close).toHaveBeenCalled();
    },
  );

  it("reports a successful HTTPS calendar fetch and parse", async () => {
    const fetchCalendar = vi.fn(async () => "BEGIN:VCALENDAR\nEND:VCALENDAR");
    const parseCalendar = vi.fn();
    const result = await Effect.runPromise(
      testStudyBuddyConnection(config, "calendar", {
        readConfiguration: async () =>
          stored({ CIS_CALENDAR_URL: "webcal://calendar.example/private.ics?token=secret" }),
        fetchCalendar,
        parseCalendar,
        now: () => checkedAt,
      }),
    );

    expect(fetchCalendar).toHaveBeenCalledWith("https://calendar.example/private.ics?token=secret");
    expect(parseCalendar).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ target: "calendar", status: "success", code: "ok" });
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("returns redacted typed diagnostics when a configured secret appears in a failure", async () => {
    const result = await Effect.runPromise(
      testStudyBuddyConnection(config, "calendar", {
        readConfiguration: async () =>
          stored({ CIS_CALENDAR_URL: "https://calendar.example/private.ics?token=secret" }),
        fetchCalendar: async () => {
          throw new Error(
            "iCalendar fetch failed at https://calendar.example/private.ics?token=secret password=hunter2",
          );
        },
        now: () => checkedAt,
      }),
    );

    expect(result).toMatchObject({
      target: "calendar",
      status: "failure",
      code: "invalid-calendar",
      checkedAt,
    });
    expect(result.message).toContain("[redacted URL]");
    expect(result.message).toContain("password=[redacted]");
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("token=secret");
  });
});
