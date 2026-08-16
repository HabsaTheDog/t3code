// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- mailparser exposes native Date values.
import { Buffer } from "node:buffer";
import type {
  StudyBuddyEmailAddress,
  StudyBuddyEmailSendApprovalPayload,
  StudyBuddyEmailMessagePage,
  StudyBuddyEmailMessageSummary,
  StudyBuddyReadEmailMessageResult,
} from "@t3tools/contracts";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 5_000_000;

export interface StudyBuddyWebmailAccess {
  readonly transport: "webmail";
  readonly sourceId: string;
  readonly profileId: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly senderEmail?: string;
  readonly folders: readonly string[];
}

export interface WebmailMessageReference {
  readonly id: string;
  readonly folder: string;
  readonly locator?: string;
}

export interface WebmailMessageRecord extends WebmailMessageReference {
  readonly subject: string;
  readonly from: readonly StudyBuddyEmailAddress[];
  readonly to: readonly StudyBuddyEmailAddress[];
  readonly sentAt?: string;
  readonly receivedAt?: string;
  readonly isSeen: boolean;
  readonly hasAttachments: boolean;
}

export interface WebmailProfileSession {
  readonly profileId: string;
}

export interface WebmailProviderProfile {
  readonly id: string;
  readonly readStateGuarantee: "verify-and-restore";
  login(access: StudyBuddyWebmailAccess): Promise<WebmailProfileSession>;
  resolveSenderEmail?(session: WebmailProfileSession): Promise<string | undefined>;
  list(
    session: WebmailProfileSession,
    input: { folder: string; query?: string; unreadOnly?: boolean; cursor?: string; limit: number },
  ): Promise<{ records: readonly WebmailMessageRecord[]; nextCursor?: string }>;
  inspectSeen(session: WebmailProfileSession, reference: WebmailMessageReference): Promise<boolean>;
  fetchRaw(session: WebmailProfileSession, reference: WebmailMessageReference): Promise<Buffer>;
  restoreSeen(
    session: WebmailProfileSession,
    reference: WebmailMessageReference,
    seen: boolean,
  ): Promise<void>;
  sendExact?(
    session: WebmailProfileSession,
    message: StudyBuddyEmailSendApprovalPayload,
  ): Promise<void>;
  close(session: WebmailProfileSession): Promise<void>;
}

export interface WebmailRuntimeDependencies {
  readonly profiles: readonly WebmailProviderProfile[];
  readonly parseMessage?: typeof simpleParser;
}

export interface StudyBuddyWebmailRuntime {
  list(
    access: StudyBuddyWebmailAccess,
    input: {
      folder?: string;
      cursor?: string;
      limit?: number;
      unreadOnly?: boolean;
      query?: string;
    },
  ): Promise<StudyBuddyEmailMessagePage>;
  read(
    access: StudyBuddyWebmailAccess,
    input: { folder?: string; messageId: string },
  ): Promise<StudyBuddyReadEmailMessageResult>;
  readContext(
    access: StudyBuddyWebmailAccess,
    input: { folder?: string; query?: string; limit?: number },
  ): Promise<StudyBuddyReadEmailMessageResult[]>;
  test(access: StudyBuddyWebmailAccess): Promise<{ senderEmail?: string }>;
  sendExact(
    access: StudyBuddyWebmailAccess,
    message: StudyBuddyEmailSendApprovalPayload,
  ): Promise<void>;
}

export function createStudyBuddyWebmailRuntime(
  dependencies: WebmailRuntimeDependencies,
): StudyBuddyWebmailRuntime {
  const profiles = new Map(dependencies.profiles.map((profile) => [profile.id, profile]));
  const parseMessage = dependencies.parseMessage ?? simpleParser;

  const withSession = async <T>(
    access: StudyBuddyWebmailAccess,
    operation: (profile: WebmailProviderProfile, session: WebmailProfileSession) => Promise<T>,
  ): Promise<T> => {
    const profile = profiles.get(access.profileId);
    if (!profile || profile.readStateGuarantee !== "verify-and-restore") {
      throw new Error(
        "This webmail provider is disabled until unread-state preservation is proven.",
      );
    }
    const session = await profile.login(access);
    try {
      return await operation(profile, session);
    } finally {
      await profile.close(session);
    }
  };

  const readOne = async (
    access: StudyBuddyWebmailAccess,
    profile: WebmailProviderProfile,
    session: WebmailProfileSession,
    reference: WebmailMessageReference,
    known?: WebmailMessageRecord,
  ): Promise<StudyBuddyReadEmailMessageResult> => {
    const seenBefore = await profile.inspectSeen(session, reference);
    const raw = await profile.fetchRaw(session, reference);
    if (raw.byteLength > MAX_MESSAGE_BYTES)
      throw new Error("Email message exceeds the safe 8 MiB reading limit.");
    let seenAfter = await profile.inspectSeen(session, reference);
    if (seenAfter !== seenBefore) {
      await profile.restoreSeen(session, reference, seenBefore);
      seenAfter = await profile.inspectSeen(session, reference);
      if (seenAfter !== seenBefore) {
        throw new Error(
          "Webmail changed the message read state and restoration could not be verified.",
        );
      }
    }
    // Content is parsed only after read-state preservation has been verified.
    const parsed = await parseMessage(raw, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    const text = sanitizeText(parsed.text ?? "");
    const html = typeof parsed.html === "string" ? sanitizeMessageHtml(parsed.html) : undefined;
    const record = known ?? recordFromParsed(reference, seenBefore, parsed);
    return {
      sourceId: access.sourceId,
      message: toSummary(profile.id, record, text.value),
      cc: parsedAddresses(parsed.cc, 512),
      replyTo: parsedAddresses(parsed.replyTo, 128),
      body: {
        sanitizedText: text.value,
        ...(html?.value ? { sanitizedHtml: html.value } : {}),
        truncated: text.truncated || Boolean(html?.truncated),
      },
      seenState: { seenBefore, seenAfter, preserved: true },
    };
  };

  const list: StudyBuddyWebmailRuntime["list"] = async (access, input) =>
    withSession(access, async (profile, session) => {
      const folder = resolveFolder(input.folder, access.folders);
      const page = await profile.list(session, {
        folder,
        ...(input.query ? { query: input.query } : {}),
        ...(input.unreadOnly ? { unreadOnly: true } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
      });
      return {
        sourceId: access.sourceId,
        messages: page.records.map((record) => toSummary(profile.id, record)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });

  const read: StudyBuddyWebmailRuntime["read"] = async (access, input) =>
    withSession(access, async (profile, session) => {
      const reference = decodeReference(input.messageId, profile.id);
      const folder = resolveFolder(input.folder ?? reference.folder, access.folders);
      if (folder !== reference.folder)
        throw new Error("Email message folder does not match the request.");
      return readOne(access, profile, session, reference);
    });

  const readContext: StudyBuddyWebmailRuntime["readContext"] = async (access, input) =>
    withSession(access, async (profile, session) => {
      const folder = resolveFolder(input.folder, access.folders);
      const limit = Math.min(Math.max(input.limit ?? 3, 1), 10);
      const page = await profile.list(session, {
        folder,
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        limit,
      });
      const results: StudyBuddyReadEmailMessageResult[] = [];
      for (const record of page.records.slice(0, limit)) {
        results.push(await readOne(access, profile, session, record, record));
      }
      return results;
    });

  const test: StudyBuddyWebmailRuntime["test"] = async (access) =>
    withSession(access, async (profile, session) => {
      const folder = resolveFolder(undefined, access.folders);
      const page = await profile.list(session, { folder, limit: 1 });
      const candidate = page.records[0];
      if (candidate) {
        // A configured account with mail must demonstrate the full invariant,
        // not merely successful authentication, before it is reported healthy.
        await readOne(access, profile, session, candidate, candidate);
      }
      let providerSender: string | undefined;
      try {
        providerSender = await profile.resolveSenderEmail?.(session);
      } catch {
        // Account identity is helpful metadata, but it must never turn a proven
        // read-safe mailbox into a failed connection check.
      }
      const senderEmail = firstValidEmail(providerSender, access.senderEmail, access.username);
      return senderEmail ? { senderEmail } : {};
    });

  const sendExact: StudyBuddyWebmailRuntime["sendExact"] = async (access, message) =>
    withSession(access, async (profile, session) => {
      if (!profile.sendExact) {
        throw new Error("This email service does not support sending through Study Buddy yet.");
      }
      await profile.sendExact(session, message);
    });

  return { list, read, readContext, test, sendExact };
}

function firstValidEmail(...values: readonly (string | undefined)[]): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value) => (value ? /^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/.test(value) : false));
}

function resolveFolder(requested: string | undefined, allowed: readonly string[]): string {
  const configured = allowed.length ? allowed : ["INBOX"];
  const folder = (requested ?? configured[0] ?? "INBOX").trim();
  const resolved = configured.find((entry) => entry.toLowerCase() === folder.toLowerCase());
  if (!resolved) throw new Error("Email folder is outside this source's configured scope.");
  return resolved;
}

function toSummary(
  profileId: string,
  record: WebmailMessageRecord,
  body = "",
): StudyBuddyEmailMessageSummary {
  return {
    messageId: encodeReference(profileId, record),
    folder: record.folder,
    subject: truncate(record.subject || "(No subject)", 2_000),
    from: record.from.slice(0, 128),
    to: record.to.slice(0, 512),
    ...(record.sentAt ? { sentAt: record.sentAt } : {}),
    ...(record.receivedAt ? { receivedAt: record.receivedAt } : {}),
    sanitizedPreview: truncate(body.replace(/\s+/g, " ").trim(), 4_000),
    isSeen: record.isSeen,
    hasAttachments: record.hasAttachments,
  };
}

function encodeReference(profileId: string, reference: WebmailMessageReference): string {
  return Buffer.from(
    JSON.stringify({
      p: profileId,
      f: reference.folder,
      i: reference.id,
      ...(reference.locator ? { l: reference.locator } : {}),
    }),
  ).toString("base64url");
}

function decodeReference(value: string, profileId: string): WebmailMessageReference {
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      data.p !== profileId ||
      typeof data.f !== "string" ||
      typeof data.i !== "string" ||
      (data.l !== undefined && typeof data.l !== "string")
    )
      throw new Error();
    return {
      id: data.i,
      folder: data.f,
      ...(typeof data.l === "string" ? { locator: data.l } : {}),
    };
  } catch {
    throw new Error("Email message identifier is stale or invalid.");
  }
}

function recordFromParsed(
  reference: WebmailMessageReference,
  isSeen: boolean,
  parsed: Awaited<ReturnType<typeof simpleParser>>,
): WebmailMessageRecord {
  return {
    ...reference,
    subject: parsed.subject ?? "(No subject)",
    from: parsedAddresses(parsed.from, 128),
    to: parsedAddresses(parsed.to, 512),
    ...(parsed.date ? { sentAt: parsed.date.toISOString() } : {}),
    isSeen,
    hasAttachments: parsed.attachments.length > 0,
  };
}

function toParsedAddress(value: {
  name?: string | undefined;
  address?: string | undefined;
}): StudyBuddyEmailAddress[] {
  const address = value.address?.trim();
  return address
    ? [
        {
          ...(value.name ? { name: truncate(value.name, 320) } : {}),
          address: truncate(address, 320),
        },
      ]
    : [];
}

function parsedAddresses(
  input:
    | { value: Array<{ name?: string | undefined; address?: string | undefined }> }
    | Array<{ value: Array<{ name?: string | undefined; address?: string | undefined }> }>
    | undefined,
  limit: number,
): StudyBuddyEmailAddress[] {
  const objects = Array.isArray(input) ? input : input ? [input] : [];
  return objects.flatMap((object) => object.value.flatMap(toParsedAddress)).slice(0, limit);
}

function sanitizeText(value: string) {
  const cleaned = value.replaceAll(String.fromCodePoint(0), "").replace(/\r\n?/g, "\n");
  return { value: truncate(cleaned, MAX_TEXT_LENGTH), truncated: cleaned.length > MAX_TEXT_LENGTH };
}

function sanitizeMessageHtml(value: string) {
  const cleaned = sanitizeHtml(value, {
    allowedTags: [
      "a",
      "b",
      "blockquote",
      "br",
      "code",
      "del",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "li",
      "ol",
      "p",
      "pre",
      "span",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "u",
      "ul",
    ],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  });
  return { value: truncate(cleaned, MAX_TEXT_LENGTH), truncated: cleaned.length > MAX_TEXT_LENGTH };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
