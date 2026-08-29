// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import type { Locator, Page } from "playwright";
import { BrowserAuthenticationGate, redactSensitiveValues } from "./browserSecurity.ts";
import type {
  LoginCandidateClassifier,
  LoginCandidateClassifierResult,
  LoginCandidateRole,
  LoginCandidateSummary,
} from "../sources/loginCandidateClassifier.ts";

export interface BrowserLoginConfig {
  readonly serviceName: string;
  readonly targetUrl: string;
  readonly resolveUsername: () => string | undefined;
  readonly resolvePassword: () => string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowInteractiveUserAction: boolean;
  readonly interactiveTimeoutMs: number;
  readonly requireCredentialSubmission: boolean;
  readonly classifyCandidates?: LoginCandidateClassifier;
}

export interface BrowserLoginAttemptOptions {
  readonly credentialSubmissionProof?: "http-auth";
}

export class HttpAuthenticationChallengeError extends Error {
  constructor(serviceName: string) {
    super(`${serviceName} returned HTTP 401 while opening the configured page.`);
    this.name = "HttpAuthenticationChallengeError";
  }
}

const DEFAULT_LOGIN_SELECTORS = {
  username: [
    "#username",
    "input[name='username']",
    "input[name='user']",
    "input[name='login']",
    "input[name='email']",
    "input[name='j_username']",
    "input[autocomplete='username']",
    "input[autocomplete='email']",
    "input[type='email']",
  ],
  password: [
    "#password",
    "input[name='password']",
    "input[name='pass']",
    "input[name='passwd']",
    "input[name='j_password']",
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
    "button:has-text('Einloggen')",
  ],
  next: [
    "button:has-text('Next')",
    "button:has-text('Continue')",
    "button:has-text('Weiter')",
    "input[type='submit']",
    "button[type='submit']",
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
  "button:has-text('Einloggen')",
] as const;

const INTERACTIVE_AUTH_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[name*='otp' i]",
  "input[name*='verification' i]",
  "iframe[src*='captcha' i]",
  "[data-sitekey]",
  "button[data-testid*='passkey' i]",
  "button:has-text('passkey')",
] as const;

const LOGIN_TERMS =
  /(?:user|username|userid|email|e-mail|login|account|benutzer|kennung|matrikel|password|passwort|passwd|kennwort|anmeld|einlog|sign[ -]?in|log[ -]?in)/i;
const USERNAME_TERMS =
  /(?:user|username|userid|email|e-mail|login|account|benutzer|kennung|matrikel)/i;
const PASSWORD_TERMS = /(?:password|passwort|passwd|kennwort|current-password)/i;
const SUBMIT_TERMS = /(?:sign[ -]?in|log[ -]?in|login|anmeld|einlog|submit|go|start)/i;
const NEXT_TERMS = /(?:next|continue|weiter|fortfahren|proceed)/i;
const MUTATION_TERMS =
  /(?:register|sign[ -]?up|create|new[ -]?password|confirm|repeat|reset|forgot|change|delete|remove|purchase|checkout|pay|bestellen|registrier|neues[ -]?passwort|passwort[ -]?ändern)/i;

interface CandidateSnapshot {
  readonly control: "input" | "button";
  readonly inputType: string;
  readonly autocomplete: string;
  readonly required: boolean;
  readonly formOrdinal: number | null;
  readonly label: string;
  readonly formAction: string;
}

interface LoginCandidate {
  readonly summary: LoginCandidateSummary;
  readonly locator: Locator;
}

interface LoginPlan {
  readonly kind: "single-step" | "username-step";
  readonly username: LoginCandidate;
  readonly password?: LoginCandidate;
  readonly action: LoginCandidate;
}

export function createBrowserLoginConfig(input: {
  readonly serviceName: string;
  readonly targetUrl: string;
  readonly username?: string;
  readonly password?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowInteractiveUserAction?: boolean;
  readonly interactiveTimeoutMs?: number;
  readonly requireCredentialSubmission?: boolean;
  readonly classifyCandidates?: LoginCandidateClassifier;
}): BrowserLoginConfig {
  const target = validatedLoginUrl(input.targetUrl, input.serviceName);
  const allowedOrigins = new Set([target.origin]);
  for (const entry of input.allowedOrigins ?? []) {
    allowedOrigins.add(validatedLoginUrl(entry, input.serviceName).origin);
  }
  return {
    serviceName: input.serviceName,
    targetUrl: target.toString(),
    resolveUsername: () => input.username,
    resolvePassword: () => input.password,
    allowedOrigins,
    allowInteractiveUserAction: input.allowInteractiveUserAction ?? false,
    interactiveTimeoutMs: input.interactiveTimeoutMs ?? 5 * 60_000,
    requireCredentialSubmission: input.requireCredentialSubmission ?? false,
    ...(input.classifyCandidates ? { classifyCandidates: input.classifyCandidates } : {}),
  };
}

export async function ensureLoggedIn(
  page: Page,
  config: BrowserLoginConfig,
  attempt: BrowserLoginAttemptOptions = {},
): Promise<void> {
  const authenticationGate = new BrowserAuthenticationGate();
  const response = await page
    .goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((error: unknown) => {
      if (/ERR_INVALID_AUTH_CREDENTIALS/i.test(error instanceof Error ? error.message : "")) {
        throw new HttpAuthenticationChallengeError(config.serviceName);
      }
      throw error;
    });
  if (response?.status() === 401) {
    throw new HttpAuthenticationChallengeError(config.serviceName);
  }
  if (!response || !response.ok()) {
    throw new Error(
      `${config.serviceName} returned HTTP ${response?.status() ?? "no response"} while opening the configured page.`,
    );
  }
  assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
  await page.waitForLoadState?.("networkidle", { timeout: 10_000 }).catch(() => undefined);

  const username = config.resolveUsername();
  const password = config.resolvePassword();
  let candidates = await discoverLoginCandidates(page, config.allowedOrigins, [username, password]);
  assertUnambiguousPasswordSurface(candidates, config.serviceName);
  let plan = deterministicLoginPlan(candidates);
  const strongLoginContext =
    isAuthenticationRoute(page.url()) ||
    candidates.some((candidate) =>
      candidate.summary.semanticSignals.some((signal) => signal === "submit" || signal === "next"),
    );
  const authenticationSurface =
    (strongLoginContext &&
      (plan !== null ||
        candidates.some((candidate) => candidate.summary.eligibleRoles.length > 0))) ||
    (await hasAuthenticationSurface(page, config.allowedOrigins));

  if (!authenticationSurface) {
    if (config.requireCredentialSubmission && attempt.credentialSubmissionProof !== "http-auth") {
      throw new Error(
        `${config.serviceName} credentials could not be verified because the configured page did not present a supported login flow in a fresh browser session.`,
      );
    }
    if (attempt.credentialSubmissionProof === "http-auth") {
      await verifyCleanAuthenticatedDocument(page, config);
    }
    return;
  }

  authenticationGate.lock();
  try {
    if (!plan && candidates.length === 0) {
      plan = await legacyLoginPlan(page, config.allowedOrigins);
    }
    if (!plan && (await hasInteractiveAuthenticationSurface(page, config.allowedOrigins))) {
      await handleInteractiveAuthentication(page, config, authenticationGate);
      await verifyCleanAuthenticatedDocument(page, config);
      authenticationGate.authenticate();
      return;
    }
    if ((!username || !password) && (plan !== null || candidates.length > 0)) {
      throw new Error(
        `${config.serviceName} login is required, but username or password is missing.`,
      );
    }

    if (!plan && config.classifyCandidates && candidates.length > 0) {
      plan = await classifiedLoginPlan(candidates, config.classifyCandidates);
    }
    if (!plan) {
      throw new Error(
        `${config.serviceName} login did not complete because the controls were ambiguous or unsupported.`,
      );
    }
    if (!username || !password) {
      throw new Error(
        `${config.serviceName} login is required, but username or password is missing.`,
      );
    }

    if (plan.kind === "username-step") {
      await injectSecret(plan.username, username);
      await clickLoginAction(page, plan.action);
      assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
      if (await hasInteractiveAuthenticationSurface(page, config.allowedOrigins)) {
        await handleInteractiveAuthentication(page, config, authenticationGate);
        await verifyCleanAuthenticatedDocument(page, config);
        authenticationGate.authenticate();
        return;
      }
      candidates = await discoverLoginCandidates(page, config.allowedOrigins, [username, password]);
      assertUnambiguousPasswordSurface(candidates, config.serviceName);
      // A model never receives a snapshot after any credential has been inserted.
      const passwordCandidate = selectCandidate(candidates, "password");
      const actionCandidate = selectCandidate(
        candidates,
        "submit",
        passwordCandidate?.summary.formOrdinal ?? null,
      );
      if (!passwordCandidate || !actionCandidate) {
        throw new Error(
          `${config.serviceName} password step was ambiguous or unsupported after username entry.`,
        );
      }
      await injectSecret(passwordCandidate, password);
      await clickLoginAction(page, actionCandidate);
    } else {
      await injectSecret(plan.username, username);
      await injectSecret(plan.password!, password);
      await clickLoginAction(page, plan.action);
    }
    assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);

    if (await hasAuthenticationSurface(page, config.allowedOrigins)) {
      if (await hasInteractiveAuthenticationSurface(page, config.allowedOrigins)) {
        await handleInteractiveAuthentication(page, config, authenticationGate);
      } else {
        throw new Error(
          redactSensitiveValues(
            await describeLoginFailure(page, config.serviceName, config.allowedOrigins),
            [username, password],
          ),
        );
      }
    }

    await verifyCleanAuthenticatedDocument(page, config);
    authenticationGate.authenticate();
  } catch (error) {
    authenticationGate.fail();
    throw error;
  }
}

function assertUnambiguousPasswordSurface(
  candidates: readonly LoginCandidate[],
  serviceName: string,
): void {
  const passwordCandidates = candidates.filter(
    (candidate) =>
      candidate.summary.eligibleRoles.includes("password") &&
      candidate.summary.riskSignals.length === 0,
  );
  if (passwordCandidates.length > 1) {
    throw new Error(
      `${serviceName} login contains multiple password fields and requires user verification.`,
    );
  }
}

async function verifyCleanAuthenticatedDocument(
  page: Page,
  config: BrowserLoginConfig,
): Promise<void> {
  const authenticatedUrl = page.url();
  await page.goto(authenticatedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertExpectedOrigin(page.url(), config.allowedOrigins, config.serviceName);
  if (await hasAuthenticationSurface(page, config.allowedOrigins)) {
    throw new Error(`${config.serviceName} authentication did not persist after secure reload.`);
  }
}

async function clickLoginAction(page: Page, candidate: LoginCandidate): Promise<void> {
  await candidate.locator.click();
  await page.waitForLoadState?.("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

async function injectSecret(candidate: LoginCandidate, value: string): Promise<void> {
  await candidate.locator.fill(value);
}

async function handleInteractiveAuthentication(
  page: Page,
  config: BrowserLoginConfig,
  gate: BrowserAuthenticationGate,
): Promise<void> {
  if (!config.allowInteractiveUserAction) {
    throw new Error(
      `${config.serviceName} requires MFA, a verification code, captcha, passkey, or other user action.`,
    );
  }
  gate.requireUserAction();
  await waitForInteractiveAuthentication(page, config);
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

function deterministicLoginPlan(candidates: readonly LoginCandidate[]): LoginPlan | null {
  const password = selectCandidate(candidates, "password");
  if (password) {
    const username = selectCandidate(candidates, "username", password.summary.formOrdinal);
    const action = selectCandidate(candidates, "submit", password.summary.formOrdinal);
    if (username && action) return { kind: "single-step", username, password, action };
    return null;
  }
  const username = selectCandidate(candidates, "username");
  const action = selectCandidate(candidates, "next", username?.summary.formOrdinal ?? null);
  return username && action ? { kind: "username-step", username, action } : null;
}

function selectCandidate(
  candidates: readonly LoginCandidate[],
  role: LoginCandidateRole,
  preferredForm: number | null = null,
): LoginCandidate | null {
  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.summary.eligibleRoles.includes(role) &&
        candidate.summary.riskSignals.length === 0,
    )
    .map((candidate) => ({
      candidate,
      score: candidateScore(candidate.summary, role, preferredForm),
    }))
    .sort((left, right) => right.score - left.score);
  const first = ranked[0];
  if (!first || first.score < 40) return null;
  const second = ranked[1];
  if (second && first.score - second.score < 15) return null;
  return first.candidate;
}

function candidateScore(
  candidate: LoginCandidateSummary,
  role: LoginCandidateRole,
  preferredForm: number | null,
): number {
  let score = 0;
  if (preferredForm !== null && candidate.formOrdinal === preferredForm) score += 35;
  if (candidate.required) score += 5;
  if (role === "password") {
    if (candidate.inputType === "password") score += 100;
    if (candidate.autocomplete === "current-password") score += 80;
    if (candidate.semanticSignals.includes("password")) score += 40;
  } else if (role === "username") {
    if (candidate.autocomplete === "username") score += 100;
    if (candidate.autocomplete === "email") score += 80;
    if (candidate.inputType === "email") score += 55;
    if (candidate.semanticSignals.includes("username")) score += 50;
  } else if (role === "submit") {
    if (candidate.inputType === "submit") score += 55;
    if (candidate.semanticSignals.includes("submit")) score += 65;
  } else {
    if (candidate.inputType === "submit") score += 35;
    if (candidate.semanticSignals.includes("next")) score += 75;
  }
  return score;
}

async function classifiedLoginPlan(
  candidates: readonly LoginCandidate[],
  classifier: LoginCandidateClassifier,
): Promise<LoginPlan | null> {
  const hasPassword = candidates.some((candidate) =>
    candidate.summary.eligibleRoles.includes("password"),
  );
  const result = await classifier({
    step: hasPassword ? "single-step" : "username-step",
    candidates: candidates.map((candidate) => candidate.summary),
  });
  if (!result || result.confidence < 0.8) return null;
  return validateClassifiedPlan(candidates, result, hasPassword);
}

function validateClassifiedPlan(
  candidates: readonly LoginCandidate[],
  result: LoginCandidateClassifierResult,
  hasPassword: boolean,
): LoginPlan | null {
  const byId = new Map(candidates.map((candidate) => [candidate.summary.id, candidate]));
  const username = result.usernameCandidateId ? byId.get(result.usernameCandidateId) : undefined;
  const password = result.passwordCandidateId ? byId.get(result.passwordCandidateId) : undefined;
  const action = byId.get(result.actionCandidateId);
  const expectedActionRole = hasPassword ? "submit" : "next";
  if (
    !username ||
    !action ||
    result.actionRole !== expectedActionRole ||
    !eligible(username, "username") ||
    !eligible(action, expectedActionRole) ||
    (hasPassword && (!password || !eligible(password, "password")))
  ) {
    return null;
  }
  const selected = [username, action, ...(password ? [password] : [])];
  if (selected.some((candidate) => candidate.summary.riskSignals.length > 0)) return null;
  const forms = selected
    .map((candidate) => candidate.summary.formOrdinal)
    .filter((value): value is number => value !== null);
  if (new Set(forms).size > 1) return null;
  return hasPassword
    ? { kind: "single-step", username, password: password!, action }
    : { kind: "username-step", username, action };
}

function eligible(candidate: LoginCandidate, role: LoginCandidateRole): boolean {
  return candidate.summary.eligibleRoles.includes(role);
}

async function discoverLoginCandidates(
  page: Page,
  allowedOrigins: ReadonlySet<string>,
  sensitiveValues: ReadonlyArray<string | undefined>,
): Promise<LoginCandidate[]> {
  const result: LoginCandidate[] = [];
  let domOrdinal = 0;
  for (const scope of approvedScopes(page, allowedOrigins)) {
    const controls = scope.locator("input, button, [role='button']");
    if (typeof controls.count !== "function" || typeof controls.nth !== "function") continue;
    const count = Math.min(await controls.count().catch(() => 0), 80);
    for (let index = 0; index < count; index += 1) {
      const locator = controls.nth(index);
      if (!(await locatorVisibleAndEnabled(locator))) continue;
      const snapshot = await locator
        .evaluate<CandidateSnapshot | null>((element: unknown) => {
          type BrowserNode = {
            readonly tagName?: string;
            readonly id?: string;
            readonly textContent?: string | null;
            readonly type?: string;
            readonly autocomplete?: string;
            readonly required?: boolean;
            readonly form?: BrowserNode | null;
            readonly labels?: ArrayLike<{ readonly textContent?: string | null }>;
            readonly ownerDocument?: { readonly forms?: ArrayLike<BrowserNode> };
            readonly getAttribute?: (name: string) => string | null;
            readonly closest?: (selector: string) => BrowserNode | null;
          };
          const node = element as BrowserNode;
          if (typeof node.getAttribute !== "function" || typeof node.closest !== "function")
            return null;
          const input = node.tagName?.toLowerCase() === "input" ? node : null;
          const form = input?.form ?? node.closest("form");
          const forms = Array.from(node.ownerDocument?.forms ?? []);
          const labels = input
            ? Array.from(input.labels ?? []).map((label) => label.textContent ?? "")
            : [];
          return {
            control: node.tagName?.toLowerCase() === "input" ? "input" : "button",
            inputType: (input?.type || node.getAttribute("type") || "button").toLowerCase(),
            autocomplete: (
              input?.autocomplete ||
              node.getAttribute("autocomplete") ||
              ""
            ).toLowerCase(),
            required: input?.required === true,
            formOrdinal: form ? forms.indexOf(form) : null,
            formAction: form?.getAttribute?.("action") ?? "",
            label: [
              node.getAttribute("aria-label") ?? "",
              node.getAttribute("placeholder") ?? "",
              node.getAttribute("name") ?? "",
              node.id ?? "",
              ...labels,
              node.textContent ?? "",
              form?.getAttribute?.("aria-label") ?? "",
              form?.getAttribute?.("name") ?? "",
            ].join(" "),
          };
        })
        .catch(() => null);
      if (!snapshot) continue;
      const label = redactSensitiveValues(normalizeCandidateLabel(snapshot.label), sensitiveValues);
      const semanticSignals = semanticSignalsFor(snapshot, label);
      const riskSignals = MUTATION_TERMS.test(`${label} ${snapshot.formAction}`)
        ? ["mutation"]
        : [];
      const eligibleRoles = eligibleRolesFor(snapshot, semanticSignals, riskSignals);
      if (eligibleRoles.length === 0 && !LOGIN_TERMS.test(label)) continue;
      result.push({
        locator,
        summary: {
          id: `candidate-${result.length}`,
          control: snapshot.control,
          inputType: snapshot.inputType,
          autocomplete: snapshot.autocomplete,
          required: snapshot.required,
          formOrdinal: snapshot.formOrdinal,
          domOrdinal,
          label,
          semanticSignals,
          riskSignals,
          eligibleRoles,
        },
      });
      domOrdinal += 1;
    }
  }
  return result;
}

function normalizeCandidateLabel(value: string): string {
  return value
    .replace(/(?:https?|webcal):\/\/\S+/gi, "[URL]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function semanticSignalsFor(snapshot: CandidateSnapshot, label: string): string[] {
  const signals: string[] = [];
  if (USERNAME_TERMS.test(`${snapshot.autocomplete} ${label}`)) signals.push("username");
  if (PASSWORD_TERMS.test(`${snapshot.autocomplete} ${label}`)) signals.push("password");
  if (SUBMIT_TERMS.test(label)) signals.push("submit");
  if (NEXT_TERMS.test(label)) signals.push("next");
  return signals;
}

function eligibleRolesFor(
  snapshot: CandidateSnapshot,
  signals: readonly string[],
  risks: readonly string[],
): LoginCandidateRole[] {
  if (risks.length > 0) return [];
  const roles: LoginCandidateRole[] = [];
  const textInput = ["text", "email", "tel", ""].includes(snapshot.inputType);
  if (
    snapshot.control === "input" &&
    textInput &&
    (signals.includes("username") || ["username", "email"].includes(snapshot.autocomplete))
  ) {
    roles.push("username");
  }
  if (
    snapshot.control === "input" &&
    snapshot.autocomplete !== "new-password" &&
    (snapshot.inputType === "password" || snapshot.autocomplete === "current-password")
  ) {
    roles.push("password");
  }
  const actionControl = snapshot.control === "button" || snapshot.inputType === "submit";
  if (actionControl && (signals.includes("submit") || snapshot.inputType === "submit")) {
    roles.push("submit");
  }
  if (actionControl && (signals.includes("next") || snapshot.inputType === "submit")) {
    roles.push("next");
  }
  return roles;
}

async function legacyLoginPlan(
  page: Page,
  allowedOrigins: ReadonlySet<string>,
): Promise<LoginPlan | null> {
  const password = await firstVisibleLocator(
    page,
    DEFAULT_LOGIN_SELECTORS.password,
    allowedOrigins,
  );
  const username = await firstVisibleLocator(
    page,
    DEFAULT_LOGIN_SELECTORS.username,
    allowedOrigins,
  );
  if (password && username) {
    const action = await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.submit, allowedOrigins);
    if (!action) return null;
    return {
      kind: "single-step",
      username: legacyCandidate(username, "username", 0),
      password: legacyCandidate(password, "password", 1),
      action: legacyCandidate(action, "submit", 2),
    };
  }
  if (username) {
    const action = await firstVisibleLocator(page, DEFAULT_LOGIN_SELECTORS.next, allowedOrigins);
    if (!action) return null;
    return {
      kind: "username-step",
      username: legacyCandidate(username, "username", 0),
      action: legacyCandidate(action, "next", 1),
    };
  }
  return null;
}

function legacyCandidate(
  locator: Locator,
  role: LoginCandidateRole,
  domOrdinal: number,
): LoginCandidate {
  return {
    locator,
    summary: {
      id: `legacy-${role}`,
      control: role === "username" || role === "password" ? "input" : "button",
      inputType: role === "password" ? "password" : role === "username" ? "text" : "submit",
      autocomplete:
        role === "password" ? "current-password" : role === "username" ? "username" : "",
      required: false,
      formOrdinal: 0,
      domOrdinal,
      label: role,
      semanticSignals: [role],
      riskSignals: [],
      eligibleRoles: [role],
    },
  };
}

function validatedLoginUrl(value: string, serviceName: string): URL {
  const target = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
    throw new Error(`${serviceName} login requires HTTPS.`);
  }
  if (target.username || target.password) {
    throw new Error(`${serviceName} login URL must not contain credentials.`);
  }
  return target;
}

function assertExpectedOrigin(
  actualUrl: string,
  allowedOrigins: ReadonlySet<string>,
  serviceName: string,
): void {
  const actual = validatedLoginUrl(actualUrl, serviceName);
  if (!allowedOrigins.has(actual.origin)) {
    throw new Error(`${serviceName} redirected to an unexpected origin.`);
  }
}

async function hasAuthenticationSurface(
  page: Page,
  allowedOrigins: ReadonlySet<string>,
): Promise<boolean> {
  if (
    (await firstVisibleLocator(page, AUTHENTICATION_SURFACE_SELECTORS, allowedOrigins)) !== null
  ) {
    return true;
  }
  return isAuthenticationRoute(page.url());
}

function isAuthenticationRoute(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(?:^|[/_-])(?:login|signin|sign-in|auth|sso|mfa|captcha|verify)(?:[/.?_-]|$)/i.test(
      `${parsed.pathname}${parsed.search}`,
    );
  } catch {
    return true;
  }
}

async function hasInteractiveAuthenticationSurface(
  page: Page,
  allowedOrigins: ReadonlySet<string>,
): Promise<boolean> {
  return (await firstVisibleLocator(page, INTERACTIVE_AUTH_SELECTORS, allowedOrigins)) !== null;
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
): Promise<Locator | null> {
  for (const scope of approvedScopes(page, allowedOrigins)) {
    for (const selector of selectors) {
      const matches = scope.locator(selector);
      if (typeof matches.count !== "function" || typeof matches.nth !== "function") {
        const candidate = matches.first();
        if (
          (await candidate.count().catch(() => 0)) > 0 &&
          (await locatorVisibleAndEnabled(candidate))
        ) {
          return candidate;
        }
        continue;
      }
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth?.(index) ?? matches.first();
        if (await locatorVisibleAndEnabled(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function locatorVisibleAndEnabled(locator: Locator): Promise<boolean> {
  const optional = locator as Locator & {
    isVisible?: () => Promise<boolean>;
    isEnabled?: () => Promise<boolean>;
  };
  const visible = optional.isVisible ? await optional.isVisible().catch(() => false) : true;
  const enabled = optional.isEnabled ? await optional.isEnabled().catch(() => false) : true;
  return visible && enabled;
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
  if (loginErrorText) return `${serviceName} login failed: ${loginErrorText}`;
  const pageText = await firstVisibleText(page, ["body"], allowedOrigins);
  if (
    pageText &&
    /(?:two[- ]factor|multi[- ]factor|mfa|verification code|security code|captcha|passkey)/i.test(
      pageText,
    )
  ) {
    return `${serviceName} login requires MFA, a verification code, captcha, passkey, or other user action.`;
  }
  return `${serviceName} login did not complete. Check the credentials or finish any required user authentication step.`;
}

async function firstVisibleText(
  page: Page,
  selectors: readonly string[],
  allowedOrigins: ReadonlySet<string>,
): Promise<string | null> {
  for (const scope of approvedScopes(page, allowedOrigins)) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      if ((await locator.count().catch(() => 0)) === 0) continue;
      const text = await locator.textContent?.().catch(() => null);
      const normalized = text?.replace(/\s+/g, " ").trim();
      if (normalized) return normalized.slice(0, 300);
    }
  }
  return null;
}
