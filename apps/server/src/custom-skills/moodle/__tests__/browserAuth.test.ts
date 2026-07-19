import { describe, expect, it, vi } from "vite-plus/test";

import { createBrowserLoginConfig, ensureLoggedIn } from "../browserAuth.ts";

describe("ensureLoggedIn connection validation", () => {
  it("rejects an HTTP error page instead of treating it as a reachable dashboard", async () => {
    const page = {
      goto: vi.fn(async () => ({
        ok: () => false,
        status: () => 503,
      })),
    };

    await expect(
      ensureLoggedIn(
        page as never,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: "https://moodle.example/my/",
          username: "student",
          password: "secret",
        }),
      ),
    ).rejects.toThrow("HTTP 503");
  });

  it("fills explicit Moodle/CIS login fields and succeeds once the form disappears", async () => {
    let currentUrl = "https://moodle.example/login/index.php";
    const filled: Array<{ selector: string; value: string }> = [];
    const loginSelectors = new Set([
      "#username",
      "#password",
      "#loginbtn",
      "input[name='username']",
      "input[name='password']",
      "button[type='submit']",
      "input[type='submit']",
    ]);

    const page = {
      goto: vi.fn(async () => ({
        ok: () => true,
        status: () => 200,
      })),
      url: vi.fn(() => currentUrl),
      waitForLoadState: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        const present = currentUrl.includes("/login/") && loginSelectors.has(selector);
        return {
          first: () => ({
            count: async () => (present ? 1 : 0),
            textContent: async () => null,
            fill: async (value: string) => {
              filled.push({ selector, value });
            },
            click: async () => {
              currentUrl = "https://moodle.example/my/";
            },
          }),
        };
      }),
    };

    await expect(
      ensureLoggedIn(
        page as never,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: "https://moodle.example/login/index.php",
          username: "student",
          password: "secret",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(filled).toContainEqual({ selector: "#username", value: "student" });
    expect(filled).toContainEqual({ selector: "#password", value: "secret" });
  });

  it("surfaces a visible login error instead of a generic still-on-login-page message", async () => {
    const page = {
      goto: vi.fn(async () => ({
        ok: () => true,
        status: () => 200,
      })),
      url: vi.fn(() => "https://moodle.example/login/index.php"),
      waitForLoadState: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => ({
        first: () => ({
          count: async () =>
            ["#username", "#password", "#loginbtn", "#loginerrormessage"].includes(selector)
              ? 1
              : 0,
          textContent: async () =>
            selector === "#loginerrormessage" ? "Invalid login, please try again" : null,
          fill: async () => undefined,
          click: async () => undefined,
        }),
      })),
    };

    await expect(
      ensureLoggedIn(
        page as never,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: "https://moodle.example/login/index.php",
          username: "student",
          password: "wrong-secret",
        }),
      ),
    ).rejects.toThrow("Moodle login failed: Invalid login, please try again");
  });

  it("reports MFA or captcha guidance when the login page stays open without a direct error", async () => {
    const page = {
      goto: vi.fn(async () => ({
        ok: () => true,
        status: () => 200,
      })),
      url: vi.fn(() => "https://moodle.example/login/index.php"),
      waitForLoadState: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => ({
        first: () => ({
          count: async () =>
            ["#username", "#password", "#loginbtn", "body"].includes(selector) ? 1 : 0,
          textContent: async () =>
            selector === "body" ? "Please enter your verification code to continue" : null,
          fill: async () => undefined,
          click: async () => undefined,
        }),
      })),
    };

    await expect(
      ensureLoggedIn(
        page as never,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: "https://moodle.example/login/index.php",
          username: "student",
          password: "secret",
        }),
      ),
    ).rejects.toThrow("verification code");
  });

  it("fails closed on an unknown SSO login surface instead of extracting it", async () => {
    const page = {
      goto: vi.fn(async () => ({ ok: () => true, status: () => 200 })),
      url: vi.fn(() => "https://identity.example/sso/login"),
      locator: vi.fn(() => ({
        first: () => ({
          count: async () => 0,
          textContent: async () => null,
        }),
      })),
    };

    await expect(
      ensureLoggedIn(
        page as never,
        createBrowserLoginConfig({
          serviceName: "University SSO",
          targetUrl: "https://identity.example/sso/login",
          allowedOrigins: ["https://identity.example"],
        }),
      ),
    ).rejects.toThrow("login did not complete");
  });

  it("redacts a password echoed by a hostile login error page", async () => {
    const password = "echo-canary-password";
    const page = {
      goto: vi.fn(async () => ({ ok: () => true, status: () => 200 })),
      url: vi.fn(() => "https://moodle.example/login/index.php"),
      waitForLoadState: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => ({
        first: () => ({
          count: async () =>
            ["#username", "#password", "#loginbtn", "#loginerrormessage"].includes(selector)
              ? 1
              : 0,
          textContent: async () =>
            selector === "#loginerrormessage" ? `Invalid password ${password}` : null,
          fill: async () => undefined,
          click: async () => undefined,
        }),
      })),
    };

    const failure = ensureLoggedIn(
      page as never,
      createBrowserLoginConfig({
        serviceName: "Moodle",
        targetUrl: "https://moodle.example/login/index.php",
        username: "student",
        password,
      }),
    );
    await expect(failure).rejects.not.toThrow(password);
    await expect(failure).rejects.toThrow("[REDACTED_CREDENTIAL]");
  });
});
