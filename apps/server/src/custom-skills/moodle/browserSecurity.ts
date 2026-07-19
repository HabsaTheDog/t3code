// @effect-diagnostics nodeBuiltinImport:off
import { lookup } from "node:dns/promises";
import net from "node:net";

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

export function redactSensitiveValues(
  input: string,
  sensitiveValues: ReadonlyArray<string | undefined>,
): string {
  let output = input;
  for (const secret of sensitiveValues) {
    if (!secret) continue;
    const values = new Set([secret]);
    try {
      values.add(encodeURIComponent(secret));
    } catch {
      // Exact-value redaction still applies.
    }
    for (const candidate of values) {
      if (candidate.length >= 3) output = output.split(candidate).join("[REDACTED_CREDENTIAL]");
    }
  }
  return output
    .replace(CREDENTIAL_URL_PARAMETER, "$1[REDACTED]")
    .replace(SENSITIVE_FIELD_LINE, "$1[REDACTED]");
}

export async function assertPublicHttpsUrl(
  value: string,
  resolveHostname: (hostname: string) => Promise<string[]> = resolveAllAddresses,
): Promise<void> {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("URL must use HTTPS.");
  if (isDisallowedHostname(parsed.hostname)) {
    throw new Error("URL resolves to a local or private network address.");
  }
  if (net.isIP(stripBrackets(parsed.hostname)) === 0) {
    const addresses = await resolveHostname(parsed.hostname);
    if (addresses.length === 0 || addresses.some(isDisallowedAddress)) {
      throw new Error("URL resolves to a local or private network address.");
    }
  }
}

function isDisallowedAddress(value: string): boolean {
  const address = stripBrackets(value).toLowerCase();
  const version = net.isIP(address);
  if (version === 4) {
    const [a = -1, b = -1, c = -1] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (version !== 6) return true;
  if (address === "::" || address === "::1") return true;
  if (/^(?:fc|fd)|^fe[89ab]|^ff|^2001:db8(?::|$)/i.test(address)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return mapped ? isDisallowedAddress(mapped) : false;
}

function isDisallowedHostname(value: string): boolean {
  const hostname = stripBrackets(value).toLowerCase().replace(/\.$/, "");
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (net.isIP(hostname) !== 0 && isDisallowedAddress(hostname))
  );
}

async function resolveAllAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function stripBrackets(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}
