// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import type { Page } from "playwright";
import type { AgentBrowserClient } from "./agentBrowserClient.ts";
import { BrowserAuthenticationGate, redactSensitiveValues } from "./browserSecurity.ts";

export interface BrowserLoginConfig {
  serviceName: string;
  targetUrl: string;
  readonly resolveUsername: () => string | undefined;
  readonly resolvePassword: () => string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowInteractiveUserAction: boolean;
  readonly interactiveTimeoutMs: number;
}

const DEFAULT_LOGIN_SELECTORS = {
  username: [
    "#username",
    "input[name='username']",
    "input[name='user']",
    "input[name='login']",
    "input[name='email']",
    "input[autocomplete='username']",
    "input[autocomplete='email']",
    "input[type='email']",
  ],
  password: [
    "#password",
    "input[name='password']",
    "input[autocomplete='current-password']",
    "input[type='password']",
  ],
  submit: [
    "#loginbtn",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Sign in')",
    "button:has-text('Log in')",
    "button:has-text('Anmelden')",
  ],
} as const;

const AUTHENTICATION_SURFACE_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[name*='otp' i]",
  "input[name*='verification' i]",
  "iframe[src*='captcha' i]",
  "[data-sitekey]",
  "button:has-text('Sign in')",
  "button:has-text('Log in')",
  "button:has-text('Anmelden')",
] as const;

export function createBrowserLoginConfig(input: {
  readonly serviceName: string;
  readonly targetUrl: string;
  readonly username?: string;
  readonly password?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowInteractiveUserAction?: boolean;
  readonly interactiveTimeoutMs?: number;
}): BrowserLoginConfig {
  const target = new URL(input.targetUrl);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
    throw new Error(`${input.serviceName} login requires HTTPS.`);
  }
  const targetOrigin = target.origin;
  return {
    serviceName: input.serviceName,
    targetUrl: input.targetUrl,
    resolveUsername: () => input.username,
    resolvePassword: () => input.password,
    allowedOrigins: new Set([targetOrigin, ...(input.allowedOrigins ?? [])]),
    allowInteractiveUserAction: input.allowInteractiveUserAction ?? false,
    interactiveTimeoutMs: input.interactiveTimeoutMs ?? 5 * 60_000,
  };
}

export async function ensureLoggedIn(page: Page, config: BrowserLoginConfig): Promise<void> {
  const authenticationGate = new BrowserAuthenticationGate();
  const response = await page.goto(config.targetUrl, {
    waitUntil: "networkidle",
    timeout: 45_000,
  });
  if (!response || !response.ok()) {
    throw new Error(
      `${config.serviceName} returned HTTP ${response?.status() ?? "no response"} while opening the configured page.`,
    );
  }
  assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
  const loginForm = await findLoginForm(page, config.allowedOrigins);
  if (!loginForm && !(await hasAuthenticationSurface(page, config.allowedOrigins))) {
    return;
  }

  authenticationGate.lock();
  try {
    const username = config.resolveUsername();
    const password = config.resolvePassword();
    if (loginForm) {
      if (!username || !password) {
        throw new Error(
          `${config.serviceName} login is required, but username or password is missing.`,
        );
      }
      await injectSecretIntoField(
        page,
        DEFAULT_LOGIN_SELECTORS.username,
        username,
        config.allowedOrigins,
      );
      await injectSecretIntoField(
        page,
        DEFAULT_LOGIN_SELECTORS.password,
        password,
        config.allowedOrigins,
      );

      const submit = await firstVisibleLocator(
        page,
        DEFAULT_LOGIN_SELECTORS.submit,
        config.allowedOrigins,
      );
      if (!submit) {
        throw new Error(`${config.serviceName} login form does not expose a submit control.`);
      }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined),
        submit.click(),
      ]);
      assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
    }

    if (await hasAuthenticationSurface(page, config.allowedOrigins)) {
      const failure = redactSensitiveValues(
        await describeLoginFailure(page, config.serviceName, config.allowedOrigins),
        [username, password],
      );
      if (
        config.allowInteractiveUserAction &&
        /(?:MFA|verification code|security code|captcha|passkey|user action)/i.test(failure)
      ) {
        authenticationGate.requireUserAction();
        await waitForInteractiveAuthentication(page, config);
      } else {
        throw new Error(failure);
      }
    }

    // Destroy the credential-bearing document before any page extraction is
    // allowed. Cookies remain in the isolated context, while the login DOM and
    // its JavaScript heap are replaced by a clean authenticated document.
    const authenticatedUrl = page.url();
    await page.goto(authenticatedUrl, { waitUntil: "networkidle", timeout: 45_000 });
    assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
    if (await hasAuthenticationSurface(page, config.allowedOrigins)) {
      throw new Error(`${config.serviceName} authentication did not persist after secure reload.`);
    }
    authenticationGate.authenticate();
  } catch (error) {
    authenticationGate.fail();
    throw error;
  }
}

async function waitForInteractiveAuthentication(
  page: Page,
  config: BrowserLoginConfig,
): Promise<void> {
  const deadline = Date.now() + config.interactiveTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
    if (!(await hasAuthenticationSurface(page, config.allowedOrigins))) return;
  }
  throw new Error(`${config.serviceName} authentication timed out waiting for user action.`);
}

function assertExpectedOrigin(
  actualUrl: string,
  allowedOrigins: ReadonlySet<string>,
  serviceName: string,
): void {
  const actual = new URL(actualUrl);
  if (!allowedOrigins.has(actual.origin)) {
    throw new Error(`${serviceName} redirected to an unexpected origin.`);
  }
}

export async function dismissCommonOverlays(page: Page): Promise<void> {
  for (const selector of [
    "text=Continue",
    "text=Weiter",
    "button:has-text('Continue')",
    "button:has-text('Weiter')",
  ]) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.click().catch(() => undefined);
    }
  }
}

export async function ensureAgentBrowserLoggedIn(
  client: AgentBrowserClient,
  config: BrowserLoginConfig,
): Promise<void> {
  if (client.secureLogin) {
    await client.secureLogin(config);
    return;
  }
  await client.open(config.targetUrl);
  const discovery = await client.snapshot({ interactive: true, urls: false, compact: true });
  const refs = Object.values(discovery.refs);
  const hasLoginForm = refs.some((ref) =>
    /(?:password|passcode|current-password)/i.test(`${ref.role ?? ""} ${ref.name ?? ""}`),
  );
  if (!hasLoginForm) {
    return;
  }
  client.lockAuthentication?.();
  client.failAuthentication?.();
  throw new Error(
    `${config.serviceName} requires login. Secure credential injection is only available through the Playwright broker; agent-browser command-line filling is blocked.`,
  );
}

export async function dismissCommonAgentBrowserOverlays(client: AgentBrowserClient): Promise<void> {
  const snapshot = await client
    .snapshot({ interactive: true, urls: false, compact: true })
    .catch(() => null);
  if (!snapshot) {
    return;
  }
  const overlayRef = Object.entries(snapshot.refs).find(([, ref]) =>
    /^(continue|weiter)$/i.test(ref.name || ""),
  )?.[0];
  if (overlayRef) {
    await client.click(`@${overlayRef}`).catch(() => undefined);
  }
}

async function findLoginForm(page: Page, allowedOrigins: ReadonlySet<string>): Promise<boolean> {
  return (
    (await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.username, allowedOrigins)) !== null &&
    (await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.password, allowedOrigins)) !== null
  );
}

async function hasAuthenticationSurface(
  page: Page,
  allowedOrigins: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const path = new URL(page.url()).pathname;
    if (/\/(?:login|signin|sign-in|auth|sso|mfa|captcha|verify)(?:[/.?_-]|$)/i.test(path)) {
      return true;
    }
  } catch {
    return true;
  }
  return (
    (await firstVisibleLocator(page, AUTHENTICATION_SURFACE_SELECTORS, allowedOrigins)) !== null
  );
}

interface LocatorScope {
  readonly url: () => string;
  readonly locator: Page["locator"];
}

function approvedScopes(page: Page, allowedOrigins: ReadonlySet<string>): LocatorScope[] {
  const pageWithOptionalFrames = page as Page & { frames?: () => LocatorScope[] };
  const scopes = pageWithOptionalFrames.frames?.() ?? [page as LocatorScope];
  return scopes.filter((scope) => {
    try {
      return allowedOrigins.has(new URL(scope.url()).origin);
    } catch {
      return false;
    }
  });
}

async function firstVisibleLocator(
  page: Page,
  selectors: readonly string[],
  allowedOrigins: ReadonlySet<string>,
) {
  for (const scope of approvedScopes(page, allowedOrigins)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) {
        return locator;
      }
    }
  }
  return null;
}

async function injectSecretIntoField(
  page: Page,
  selectors: readonly string[],
  value: string,
  allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  const locator = await firstVisibleLocator(page, selectors, allowedOrigins);
  if (!locator) {
    throw new Error("Login form fields were not found.");
  }
  await locator.fill(value);
}

async function describeLoginFailure(
  page: Page,
  serviceName: string,
  allowedOrigins: ReadonlySet<string>,
): Promise<string> {
  const loginErrorText = await firstVisibleText(
    page,
    [
      "#loginerrormessage",
      ".loginerrors",
      ".alert-danger",
      ".alert.alert-danger",
      "[role='alert']",
      ".error",
    ],
    allowedOrigins,
  );
  if (loginErrorText) {
    return `${serviceName} login failed: ${loginErrorText}`;
  }

  const pageText = await firstVisibleText(page, ["body"], allowedOrigins);
  if (
    pageText &&
    /(two[- ]factor|multi[- ]factor|mfa|verification code|security code|captcha)/i.test(pageText)
  ) {
    return `${serviceName} login did not complete because the site appears to require MFA, a verification code, or a captcha. Complete that step in the browser and try again.`;
  }

  return `${serviceName} login did not complete. Check username and password. If the site is asking for MFA, a verification code, or a captcha, complete that in the browser and try again.`;
}

async function firstVisibleText(
  page: Page,
  selectors: readonly string[],
  allowedOrigins: ReadonlySet<string>,
): Promise<string | null> {
  for (const scope of approvedScopes(page, allowedOrigins)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      if ((await locator.count().catch(() => 0)) === 0) {
        continue;
      }
      const text = await locator.textContent?.().catch(() => null);
      const normalized = text?.replace(/\s+/g, " ").trim();
      if (normalized) {
        return normalized.slice(0, 300);
      }
    }
  }
  return null;
}
