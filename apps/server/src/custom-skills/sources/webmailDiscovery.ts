// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
import { createHash } from "node:crypto";

import { assertPublicHttpsUrl } from "../moodle/browserSecurity.ts";

const MAX_DISCOVERY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 4;

export type StudyBuddyMailProviderId =
  | "imap"
  | "sogo"
  | "roundcube"
  | "microsoft-365"
  | "google-workspace"
  | "other-webmail";

export interface StudyBuddyMailProviderProfile {
  readonly id: StudyBuddyMailProviderId;
  readonly label: string;
  readonly transport: "imap" | "web-session" | "provider-api" | "adaptive";
  readonly authentication: {
    readonly kind: "password" | "form-session" | "oauth" | "adaptive";
    readonly endpoint: string;
    readonly usernameField?: string;
    readonly passwordField?: string;
    readonly csrfField?: string;
    readonly scopes?: readonly string[];
  };
  readonly strategies: {
    readonly list: string;
    readonly search: string;
    readonly read: string;
  };
  readonly readState: {
    readonly invariant: "peek-only" | "verify-and-restore" | "non-mutating-api" | "unproven";
    readonly proven: boolean;
    readonly verification: string;
    readonly remediation?: string;
  };
  readonly runtime: "available" | "requires-oauth" | "disabled-until-proven";
}

export interface SanitizedWebmailMetadata {
  readonly finalUrl: string;
  readonly status: number;
  readonly title?: string;
  readonly formActions: readonly string[];
  readonly fieldNames: readonly string[];
  readonly assetHints: readonly string[];
  readonly headerNames: readonly string[];
  readonly bodyFingerprint: string;
}

export interface StudyBuddyWebmailDiscoveryResult {
  readonly profile: StudyBuddyMailProviderProfile;
  readonly confidence: "high" | "medium" | "fallback";
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly evidence: readonly string[];
  /** Safe input for an optional research agent. Never contains page text or header values. */
  readonly researchMetadata: SanitizedWebmailMetadata;
}

export interface WebmailDiscoverySnapshot {
  readonly url: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly html: string;
}

export type WebmailDiscoveryFetch = (input: string, init: RequestInit) => Promise<Response>;

export const STUDY_BUDDY_MAIL_PROVIDER_PROFILES: Readonly<
  Record<StudyBuddyMailProviderId, StudyBuddyMailProviderProfile>
> = {
  imap: {
    id: "imap",
    label: "Encrypted IMAP",
    transport: "imap",
    authentication: { kind: "password", endpoint: "imaps://host:993" },
    strategies: {
      list: "IMAP SEARCH/FETCH metadata in an EXAMINE mailbox",
      search: "IMAP SEARCH in an EXAMINE mailbox",
      read: "IMAP BODY.PEEK[] in an EXAMINE mailbox",
    },
    readState: {
      invariant: "peek-only",
      proven: true,
      verification: "Compare the \\Seen flag before and after BODY.PEEK[].",
    },
    runtime: "available",
  },
  sogo: {
    id: "sogo",
    label: "SOGo Webmail",
    transport: "web-session",
    authentication: {
      kind: "form-session",
      endpoint: "connect",
      usernameField: "userName",
      passwordField: "password",
    },
    strategies: {
      list: "SOGo Mail folder view/headers endpoint within the authenticated account route",
      search: "SOGo Mail folder search/view endpoint within the authenticated account route",
      read: "SOGo message export endpoint, with flags checked before and after",
    },
    readState: {
      invariant: "peek-only",
      proven: true,
      verification:
        "The server export path uses an IMAP PEEK fetch; verify unread flags around every read.",
      remediation:
        "If a deployment mutates the flag, immediately restore unread and fail the read-state proof.",
    },
    runtime: "available",
  },
  roundcube: {
    id: "roundcube",
    label: "Roundcube Webmail",
    transport: "web-session",
    authentication: {
      kind: "form-session",
      endpoint: "?_task=login",
      usernameField: "_user",
      passwordField: "_pass",
      csrfField: "_token",
    },
    strategies: {
      list: "Roundcube mail list JSON request",
      search: "Roundcube mail search JSON request",
      read: "Deployment-specific raw-source or message request",
    },
    readState: {
      invariant: "verify-and-restore",
      proven: true,
      verification:
        "Inspect the flag before and after raw-source retrieval and verify any restoration.",
      remediation:
        "Restore the original read state and fail closed if the restored state cannot be verified.",
    },
    runtime: "available",
  },
  "microsoft-365": {
    id: "microsoft-365",
    label: "Microsoft 365 / Outlook",
    transport: "provider-api",
    authentication: {
      kind: "oauth",
      endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      scopes: ["Mail.Read"],
    },
    strategies: {
      list: "Microsoft Graph /me/messages with bounded $select and paging",
      search: "Microsoft Graph /me/messages bounded query/search",
      read: "Microsoft Graph GET /me/messages/{id}",
    },
    readState: {
      invariant: "non-mutating-api",
      proven: true,
      verification: "Use GET only and reject update, move, delete, draft, and send operations.",
    },
    runtime: "requires-oauth",
  },
  "google-workspace": {
    id: "google-workspace",
    label: "Google Workspace / Gmail",
    transport: "provider-api",
    authentication: {
      kind: "oauth",
      endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
    strategies: {
      list: "Gmail API users.messages.list with bounded maxResults",
      search: "Gmail API users.messages.list with a q filter",
      read: "Gmail API users.messages.get",
    },
    readState: {
      invariant: "non-mutating-api",
      proven: true,
      verification: "Use the gmail.readonly scope and reject modify, draft, and send methods.",
    },
    runtime: "requires-oauth",
  },
  "other-webmail": {
    id: "other-webmail",
    label: "Other webmail",
    transport: "adaptive",
    authentication: { kind: "adaptive", endpoint: "discovered-after-approval" },
    strategies: {
      list: "Unavailable until a constrained provider profile is validated",
      search: "Unavailable until a constrained provider profile is validated",
      read: "Unavailable until a non-mutating read strategy is proven",
    },
    readState: {
      invariant: "unproven",
      proven: false,
      verification:
        "An adapter must prove unchanged unread state before mailbox content can cross the broker.",
    },
    runtime: "disabled-until-proven",
  },
};

export async function discoverStudyBuddyWebmailProvider(
  inputUrl: string,
  dependencies: {
    readonly fetch?: WebmailDiscoveryFetch;
    readonly assertPublicUrl?: (url: string) => Promise<void>;
  } = {},
): Promise<StudyBuddyWebmailDiscoveryResult> {
  const fetchImpl = dependencies.fetch ?? ((input, init) => fetch(input, init));
  const assertPublicUrl = dependencies.assertPublicUrl ?? assertPublicHttpsUrl;
  let current = normalizeDiscoveryUrl(inputUrl);
  let response: Response | undefined;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicUrl(current.href);
    response = await fetchImpl(current.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { accept: "text/html,application/xhtml+xml;q=0.9" },
      signal: AbortSignal.timeout(15_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Webmail discovery received a redirect without a location.");
    current = normalizeDiscoveryUrl(new URL(location, current).href);
    if (redirects === MAX_REDIRECTS)
      throw new Error("Webmail discovery followed too many redirects.");
  }

  if (!response) throw new Error("Webmail discovery did not receive a response.");
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Webmail discovery returned HTTP ${response.status}.`);
  }
  const html = await readLimitedText(response, MAX_DISCOVERY_BYTES);
  return discoverStudyBuddyWebmailProviderFromSnapshot({
    url: current.href,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    html,
  });
}

export function discoverStudyBuddyWebmailProviderFromSnapshot(
  snapshot: WebmailDiscoverySnapshot,
): StudyBuddyWebmailDiscoveryResult {
  const url = normalizeDiscoveryUrl(snapshot.url);
  const metadata = sanitizeDiscoveryMetadata(snapshot, url);
  const lowerHtml = snapshot.html.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const candidates: Array<{
    id: Exclude<StudyBuddyMailProviderId, "imap" | "other-webmail">;
    score: number;
    evidence: string[];
  }> = [
    scoreSogo(url, lowerHtml, metadata),
    scoreRoundcube(lowerHtml, metadata),
    scoreMicrosoft(hostname, lowerHtml),
    scoreGoogle(hostname, lowerHtml),
  ];
  candidates.sort((left, right) => right.score - left.score);
  const winner = candidates[0]!;
  const detected = winner.score >= 4;
  const profile = STUDY_BUDDY_MAIL_PROVIDER_PROFILES[detected ? winner.id : "other-webmail"];
  return {
    profile,
    confidence: winner.score >= 8 ? "high" : detected ? "medium" : "fallback",
    baseUrl: publicUrl(url),
    allowedOrigins: allowedOriginsFor(profile.id, url.origin),
    evidence: detected ? winner.evidence : ["No supported provider fingerprint reached threshold"],
    researchMetadata: metadata,
  };
}

function scoreSogo(
  url: URL,
  html: string,
  metadata: SanitizedWebmailMetadata,
): { id: "sogo"; score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  if (/^\/sogo(?:\/|$)/i.test(url.pathname)) {
    score += 3;
    evidence.push("SOGo path");
  }
  if (/sogo\.woa|\/sogo\/connect|\bsogo\b/i.test(html)) {
    score += 4;
    evidence.push("SOGo public asset or connect marker");
  }
  if (metadata.fieldNames.includes("userName") && metadata.fieldNames.includes("password")) {
    score += 3;
    evidence.push("SOGo login fields");
  }
  return { id: "sogo", score, evidence };
}

function scoreRoundcube(
  html: string,
  metadata: SanitizedWebmailMetadata,
): { id: "roundcube"; score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  if (/\broundcube(?:mail)?\b|rcmloginuser|roundcube_sess/i.test(html)) {
    score += 5;
    evidence.push("Roundcube public marker");
  }
  if (metadata.fieldNames.includes("_user") && metadata.fieldNames.includes("_pass")) {
    score += 3;
    evidence.push("Roundcube login fields");
  }
  if (
    metadata.fieldNames.includes("_token") ||
    metadata.formActions.some((v) => v.includes("_task=login"))
  ) {
    score += 2;
    evidence.push("Roundcube login token or task route");
  }
  return { id: "roundcube", score, evidence };
}

function scoreMicrosoft(
  hostname: string,
  html: string,
): { id: "microsoft-365"; score: number; evidence: string[] } {
  const knownHost =
    isDomain(hostname, "outlook.office.com") ||
    isDomain(hostname, "office.com") ||
    isDomain(hostname, "microsoftonline.com") ||
    isDomain(hostname, "live.com");
  const branded = /microsoft|office 365|outlook/i.test(html);
  return {
    id: "microsoft-365",
    score: (knownHost ? 8 : 0) + (branded ? 2 : 0),
    evidence: [
      ...(knownHost ? ["Microsoft-owned host"] : []),
      ...(branded ? ["Microsoft public marker"] : []),
    ],
  };
}

function scoreGoogle(
  hostname: string,
  html: string,
): { id: "google-workspace"; score: number; evidence: string[] } {
  const knownHost =
    isDomain(hostname, "mail.google.com") || isDomain(hostname, "accounts.google.com");
  const branded = /gmail|google workspace|accounts\.google/i.test(html);
  return {
    id: "google-workspace",
    score: (knownHost ? 8 : 0) + (branded ? 2 : 0),
    evidence: [
      ...(knownHost ? ["Google-owned host"] : []),
      ...(branded ? ["Google public marker"] : []),
    ],
  };
}

function sanitizeDiscoveryMetadata(
  snapshot: WebmailDiscoverySnapshot,
  url: URL,
): SanitizedWebmailMetadata {
  const title = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i
    .exec(snapshot.html)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const fieldNames = uniqueMatches(
    snapshot.html,
    /<(?:input|select|textarea)\b[^>]*\bname=["']([^"']{1,128})["']/gi,
  );
  const formActions = uniqueMatches(
    snapshot.html,
    /<form\b[^>]*\baction=["']([^"']{1,500})["']/gi,
  ).flatMap((value) => safeRelativeRoute(value, url));
  const assetHints = uniqueMatches(
    snapshot.html,
    /<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']{1,500})["']/gi,
  ).flatMap((value) => safeAssetHint(value, url));
  return {
    finalUrl: publicUrl(url),
    status: snapshot.status,
    ...(title ? { title } : {}),
    formActions: formActions.slice(0, 16),
    fieldNames: fieldNames.slice(0, 32),
    assetHints: assetHints.slice(0, 24),
    headerNames: Object.keys(snapshot.headers ?? {})
      .map((value) => value.toLowerCase())
      .sort()
      .slice(0, 32),
    bodyFingerprint: createHash("sha256").update(snapshot.html).digest("hex"),
  };
}

function uniqueMatches(input: string, pattern: RegExp): string[] {
  return [...new Set(Array.from(input.matchAll(pattern), (match) => match[1]!).filter(Boolean))];
}

function safeRelativeRoute(value: string, base: URL): string[] {
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || parsed.username || parsed.password) return [];
    return [`${parsed.pathname}${parsed.search}`.slice(0, 500)];
  } catch {
    return [];
  }
}

function safeAssetHint(value: string, base: URL): string[] {
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return [];
    const parts = parsed.pathname.split("/").filter(Boolean).slice(-3);
    return parts.length > 0 ? [`/${parts.join("/")}`] : [];
  } catch {
    return [];
  }
}

function allowedOriginsFor(id: StudyBuddyMailProviderId, sourceOrigin: string): string[] {
  if (id === "microsoft-365") {
    return [
      ...new Set([
        sourceOrigin,
        "https://login.microsoftonline.com",
        "https://graph.microsoft.com",
      ]),
    ];
  }
  if (id === "google-workspace") {
    return [
      ...new Set([sourceOrigin, "https://accounts.google.com", "https://gmail.googleapis.com"]),
    ];
  }
  return [sourceOrigin];
}

function normalizeDiscoveryUrl(value: string): URL {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Webmail discovery requires HTTPS without embedded credentials.");
  }
  parsed.hash = "";
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|password|passwd|passcode|api[_-]?key|auth|credential)/i.test(key)) {
      throw new Error("Webmail discovery URL contains a credential-like parameter.");
    }
  }
  return parsed;
}

function publicUrl(value: URL): string {
  const copy = new URL(value.href);
  copy.search = "";
  copy.hash = "";
  return copy.href;
}

function isDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error("Webmail discovery response exceeds the safe size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Webmail discovery response exceeds the safe size limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
