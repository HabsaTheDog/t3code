import type { Browser } from "playwright";
import {
  createBrowserLoginConfig,
  ensureLoggedIn,
  HttpAuthenticationChallengeError,
  type BrowserLoginConfig,
} from "../moodle/browserAuth.ts";
import type { LoginCandidateClassifier } from "./loginCandidateClassifier.ts";

export interface PasswordPortalConnectionInput {
  readonly browser: Browser;
  readonly serviceName: string;
  readonly targetUrl: string;
  readonly username: string;
  readonly password: string;
  readonly allowedOrigins: readonly string[];
  readonly classifyCandidates?: LoginCandidateClassifier;
  readonly requireCredentialSubmission?: boolean;
}

export async function connectPasswordPortal(input: PasswordPortalConnectionInput): Promise<void> {
  const loginConfig = createBrowserLoginConfig({
    serviceName: input.serviceName,
    targetUrl: input.targetUrl,
    username: input.username,
    password: input.password,
    allowedOrigins: input.allowedOrigins,
    requireCredentialSubmission: input.requireCredentialSubmission ?? true,
    ...(input.classifyCandidates ? { classifyCandidates: input.classifyCandidates } : {}),
  });

  const context = await input.browser.newContext();
  try {
    const page = await context.newPage();
    await ensureLoggedIn(page, loginConfig);
    return;
  } catch (error) {
    if (!isHttpAuthenticationChallenge(error)) throw error;
  } finally {
    await context.close();
  }

  await connectWithHttpAuthentication(input, loginConfig);
}

async function connectWithHttpAuthentication(
  input: PasswordPortalConnectionInput,
  loginConfig: BrowserLoginConfig,
): Promise<void> {
  const targetOrigin = new URL(loginConfig.targetUrl).origin;
  if (!loginConfig.allowedOrigins.has(targetOrigin)) {
    throw new Error(`${input.serviceName} HTTP authentication origin is not allowed.`);
  }
  const context = await input.browser.newContext({
    httpCredentials: {
      username: input.username,
      password: input.password,
      origin: targetOrigin,
    },
  });
  try {
    const page = await context.newPage();
    await ensureLoggedIn(page, loginConfig, { credentialSubmissionProof: "http-auth" });
  } finally {
    await context.close();
  }
}

export function isHttpAuthenticationChallenge(error: unknown): boolean {
  return error instanceof HttpAuthenticationChallengeError;
}
