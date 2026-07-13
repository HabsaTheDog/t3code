export type BrowserAuthenticationState =
  | "discovery"
  | "auth-locked"
  | "user-action-required"
  | "authenticated"
  | "failed";

export class BrowserAuthenticationLockedError extends Error {
  constructor(operation: string) {
    super(`Browser ${operation} is unavailable while authentication is locked.`);
    this.name = "BrowserAuthenticationLockedError";
  }
}

/**
 * Tracks the authentication transaction independently from the page DOM. Once
 * credential injection starts, page content must not leave the browser worker
 * until authentication reaches a terminal state.
 */
export class BrowserAuthenticationGate {
  #state: BrowserAuthenticationState = "discovery";

  get state(): BrowserAuthenticationState {
    return this.#state;
  }

  lock(): void {
    if (this.#state === "auth-locked" || this.#state === "user-action-required") return;
    if (this.#state !== "discovery") {
      throw new Error(`Cannot start authentication from ${this.#state}.`);
    }
    this.#state = "auth-locked";
  }

  requireUserAction(): void {
    if (this.#state !== "auth-locked") {
      throw new Error(`Cannot request user authentication action from ${this.#state}.`);
    }
    this.#state = "user-action-required";
  }

  authenticate(): void {
    if (this.#state !== "auth-locked" && this.#state !== "user-action-required") {
      throw new Error(`Cannot complete authentication from ${this.#state}.`);
    }
    this.#state = "authenticated";
  }

  fail(): void {
    if (this.#state !== "authenticated") this.#state = "failed";
  }

  assertReadable(operation = "snapshot"): void {
    if (this.#state === "auth-locked" || this.#state === "user-action-required") {
      throw new BrowserAuthenticationLockedError(operation);
    }
  }
}

const SENSITIVE_FIELD_LINE =
  /^\s*((?:password|passwd|passcode|secret|token|authorization|credential|current-password)(?:\s+(?:value|text|name))?\s*[:=]\s*)(.*)$/gim;
const CREDENTIAL_URL_PARAMETER =
  /([?&](?:token|secret|password|passwd|passcode|api[_-]?key|auth|credential)[^=&#]*=)[^&#\s"'<>]*/gi;
const CREDENTIAL_MASK = /(?:[•●▪◦]\s*){2,}|\*{3,}/g;

function variants(value: string): string[] {
  if (!value) return [];
  const output = new Set([value]);
  try {
    output.add(encodeURIComponent(value));
  } catch {
    // Exact-value redaction still applies.
  }
  return [...output].filter((candidate) => candidate.length >= 3);
}

/** Defense-in-depth redaction for every model-visible browser/string result. */
export function redactSensitiveValues(
  input: string,
  sensitiveValues: ReadonlyArray<string | undefined>,
): string {
  let output = input;
  for (const secret of sensitiveValues) {
    if (!secret) continue;
    for (const candidate of variants(secret)) {
      output = output.split(candidate).join("[REDACTED_CREDENTIAL]");
    }
  }
  return output
    .replace(CREDENTIAL_URL_PARAMETER, "$1[REDACTED]")
    .replace(SENSITIVE_FIELD_LINE, "$1[REDACTED]");
}

export function sanitizeModelVisibleUrl(
  input: string,
  sensitiveValues: ReadonlyArray<string | undefined> = [],
): string {
  try {
    const url = new URL(redactSensitiveValues(input, sensitiveValues));
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|passwd|passcode|api[_-]?key|auth|credential)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

export interface SanitizableBrowserSnapshot {
  origin: string;
  refs: Record<string, { role?: string; name?: string }>;
  snapshot: string;
}

export function isAuthenticationSnapshot(snapshot: SanitizableBrowserSnapshot): boolean {
  try {
    const path = new URL(snapshot.origin).pathname;
    if (/\/(?:login|signin|sign-in|auth|sso|mfa|captcha|verify)(?:[/.?_-]|$)/i.test(path)) {
      return true;
    }
  } catch {
    return true;
  }
  return Object.values(snapshot.refs).some((ref) =>
    /(?:password|passwd|passcode|current-password|one-time-code|captcha)/i.test(
      `${ref.role ?? ""} ${ref.name ?? ""}`,
    ),
  );
}

/**
 * Produces a new object so callers cannot retain a raw snapshot by reference.
 * Password/credential fields expose state only, never a value or bullet count.
 */
export function sanitizeBrowserSnapshot<T extends SanitizableBrowserSnapshot>(
  snapshot: T,
  sensitiveValues: ReadonlyArray<string | undefined>,
): T {
  const refs = Object.fromEntries(
    Object.entries(snapshot.refs).map(([key, ref]) => {
      const name = redactSensitiveValues(ref.name ?? "", sensitiveValues);
      const sensitive =
        /(?:password|passwd|passcode|secret|token|credential)/i.test(`${ref.role ?? ""} ${name}`) ||
        CREDENTIAL_MASK.test(name);
      CREDENTIAL_MASK.lastIndex = 0;
      return [
        key,
        {
          ...(ref.role ? { role: ref.role } : {}),
          ...(name ? { name: sensitive ? "Credential" : name } : {}),
          ...(sensitive ? { name: "Credential", sensitive: true, state: "credential-field" } : {}),
        },
      ];
    }),
  );
  return {
    ...snapshot,
    origin: sanitizeModelVisibleUrl(snapshot.origin, sensitiveValues),
    refs,
    snapshot: redactSensitiveValues(snapshot.snapshot, sensitiveValues)
      .replace(CREDENTIAL_MASK, "[CREDENTIAL_STATE_REDACTED]")
      .replace(
        /(textbox|input)[^\n]*(?:password|passwd|passcode|secret|token|credential)[^\n]*/gi,
        '$1 "Credential" [sensitive=true, state=credential-field]',
      ),
  } as T;
}
