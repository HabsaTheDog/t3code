import type { Page } from "playwright";
import type { AgentBrowserClient } from "./agentBrowserClient.ts";

export interface BrowserLoginConfig {
  serviceName: string;
  targetUrl: string;
  readonly resolveUsername: () => string | undefined;
  readonly resolvePassword: () => string | undefined;
}

const DEFAULT_LOGIN_SELECTORS = {
  username: ["#username", "input[name='username']", "input[autocomplete='username']"],
  password: ["#password", "input[name='password']", "input[autocomplete='current-password']"],
  submit: ["#loginbtn", "button[type='submit']", "input[type='submit']"],
} as const;

export function createBrowserLoginConfig(input: {
  readonly serviceName: string;
  readonly targetUrl: string;
  readonly username?: string;
  readonly password?: string;
}): BrowserLoginConfig {
  return {
    serviceName: input.serviceName,
    targetUrl: input.targetUrl,
    resolveUsername: () => input.username,
    resolvePassword: () => input.password,
  };
}

export async function ensureLoggedIn(page: Page, config: BrowserLoginConfig): Promise<void> {
  const response = await page.goto(config.targetUrl, {
    waitUntil: "networkidle",
    timeout: 45_000,
  });
  if (!response || !response.ok()) {
    throw new Error(
      `${config.serviceName} returned HTTP ${response?.status() ?? "no response"} while opening the configured page.`,
    );
  }
  assertExpectedOrigin(page.url(), config.targetUrl, config.serviceName);
  const loginForm = await findLoginForm(page);
  if (!loginForm) {
    return;
  }

  const username = config.resolveUsername();
  const password = config.resolvePassword();
  if (!username || !password) {
    throw new Error(
      `${config.serviceName} login is required, but username or password is missing.`,
    );
  }

  await injectSecretIntoField(page, DEFAULT_LOGIN_SELECTORS.username, username);
  await injectSecretIntoField(page, DEFAULT_LOGIN_SELECTORS.password, password);

  const submit = await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.submit);
  if (!submit) {
    throw new Error(`${config.serviceName} login form does not expose a submit control.`);
  }

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined),
    submit.click(),
  ]);
  assertExpectedOrigin(page.url(), config.targetUrl, config.serviceName);
  if (await findLoginForm(page)) {
    throw new Error(await describeLoginFailure(page, config.serviceName));
  }
}

function assertExpectedOrigin(actualUrl: string, expectedUrl: string, serviceName: string): void {
  const actual = new URL(actualUrl);
  const expected = new URL(expectedUrl);
  if (actual.origin !== expected.origin) {
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
  await client.open(config.targetUrl);
  const username = config.resolveUsername();
  const password = config.resolvePassword();
  if (!username || !password) {
    throw new Error(
      `${config.serviceName} login is required, but username or password is missing.`,
    );
  }

  const usernameSelector = await tryFillAgentBrowserSecret(
    client,
    DEFAULT_LOGIN_SELECTORS.username,
    username,
  );
  const passwordSelector = await tryFillAgentBrowserSecret(
    client,
    DEFAULT_LOGIN_SELECTORS.password,
    password,
  );
  if (!usernameSelector && !passwordSelector) {
    return;
  }
  if (!usernameSelector || !passwordSelector) {
    throw new Error(`${config.serviceName} login form fields were not found.`);
  }

  const clicked = await tryAgentBrowserClick(client, DEFAULT_LOGIN_SELECTORS.submit);
  if (!clicked) {
    await client.press("Enter");
  }
  const postLoginUsername = await tryFillAgentBrowserSecret(client, [usernameSelector], username);
  const postLoginPassword = await tryFillAgentBrowserSecret(client, [passwordSelector], password);
  if (postLoginUsername || postLoginPassword) {
    throw new Error(
      `${config.serviceName} login did not complete. Check username and password. If the site is asking for MFA, a verification code, or a captcha, complete that in the browser and try again.`,
    );
  }
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

async function findLoginForm(page: Page): Promise<boolean> {
  return (
    (await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.username)) !== null &&
    (await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.password)) !== null
  );
}

async function firstVisibleLocator(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) > 0) {
      return locator;
    }
  }
  return null;
}

async function tryFillAgentBrowserSecret(
  client: AgentBrowserClient,
  selectors: readonly string[],
  value: string,
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await client.fill(selector, value);
      return selector;
    } catch {
      continue;
    }
  }
  return null;
}

async function injectSecretIntoField(
  page: Page,
  selectors: readonly string[],
  value: string,
): Promise<void> {
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) {
    throw new Error("Login form fields were not found.");
  }
  await locator.fill(value);
}

async function tryAgentBrowserClick(
  client: AgentBrowserClient,
  selectors: readonly string[],
): Promise<boolean> {
  for (const selector of selectors) {
    try {
      await client.click(selector);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function describeLoginFailure(page: Page, serviceName: string): Promise<string> {
  const loginErrorText = await firstVisibleText(page, [
    "#loginerrormessage",
    ".loginerrors",
    ".alert-danger",
    ".alert.alert-danger",
    "[role='alert']",
    ".error",
  ]);
  if (loginErrorText) {
    return `${serviceName} login failed: ${loginErrorText}`;
  }

  const pageText = await firstVisibleText(page, ["body"]);
  if (pageText && /(two[- ]factor|multi[- ]factor|mfa|verification code|security code|captcha)/i.test(pageText)) {
    return `${serviceName} login did not complete because the site appears to require MFA, a verification code, or a captcha. Complete that step in the browser and try again.`;
  }

  return `${serviceName} login did not complete. Check username and password. If the site is asking for MFA, a verification code, or a captcha, complete that in the browser and try again.`;
}

async function firstVisibleText(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    const text = await locator.textContent?.().catch(() => null);
    const normalized = text?.replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized.slice(0, 300);
    }
  }
  return null;
}
