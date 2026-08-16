// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- IMAP and mailparser expose native Date values.
import { Buffer } from "node:buffer";
import type {
  StudyBuddyEmailAddress,
  StudyBuddyEmailMessagePage,
  StudyBuddyEmailMessageSummary,
  StudyBuddyEmailSendApprovalPayload,
  StudyBuddyListEmailMessagesInput,
  StudyBuddyReadEmailMessageInput,
  StudyBuddyReadEmailMessageResult,
  StudyBuddySearchEmailMessagesInput,
} from "@t3tools/contracts";
import { ImapFlow } from "imapflow";
import type {
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  MailboxObject,
  MessageAddressObject,
  MessageStructureObject,
  SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { createRoundcubeWebmailProfile, createSogoWebmailProfile } from "./webmailProfiles.ts";
import {
  createStudyBuddyWebmailRuntime,
  type StudyBuddyWebmailAccess,
  type StudyBuddyWebmailRuntime,
} from "./webmailProfileRuntime.ts";

const DEFAULT_FOLDER = "INBOX";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 5_000_000;

export interface StudyBuddyImapAccess {
  readonly transport: "imap";
  readonly sourceId: string;
  readonly host: string;
  readonly port: number;
  readonly secure: true;
  readonly username: string;
  readonly password: string;
  readonly senderEmail?: string;
  readonly folders: readonly string[];
}

export type StudyBuddyEmailAccess = StudyBuddyImapAccess | StudyBuddyWebmailAccess;

export interface ImapClientLike {
  readonly usable: boolean;
  connect(): Promise<void>;
  close(): void;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<MailboxObject>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false>;
  fetchAll(
    range: number[],
    query: FetchQueryObject,
    options: FetchOptions & { uid: true },
  ): Promise<FetchMessageObject[]>;
  fetchOne(
    uid: number,
    query: FetchQueryObject,
    options: FetchOptions & { uid: true },
  ): Promise<FetchMessageObject | false>;
}

interface ParsedEmail {
  readonly text?: string | undefined;
  readonly html?: string | false | undefined;
}

export interface StudyBuddyEmailBrokerDependencies {
  readonly createClient?: (options: ImapFlowOptions) => ImapClientLike;
  readonly parseMessage?: (source: Buffer) => Promise<ParsedEmail>;
  readonly webmailRuntime?: StudyBuddyWebmailRuntime;
}

export interface StudyBuddyEmailReadBroker {
  listMessages(input: StudyBuddyListEmailMessagesInput): Promise<StudyBuddyEmailMessagePage>;
  searchMessages(input: StudyBuddySearchEmailMessagesInput): Promise<StudyBuddyEmailMessagePage>;
  readMessage(input: StudyBuddyReadEmailMessageInput): Promise<StudyBuddyReadEmailMessageResult>;
  readContext(input: {
    readonly sourceId: string;
    readonly folder?: string;
    readonly query?: string;
    readonly limit?: number;
  }): Promise<StudyBuddyReadEmailMessageResult[]>;
  testConnection(sourceId: string): Promise<{ senderEmail?: string }>;
  sendExact(message: StudyBuddyEmailSendApprovalPayload): Promise<void>;
}

export function createStudyBuddyEmailReadBroker(
  resolveAccess: (
    sourceId: string,
    purpose: "read" | "test" | "send",
  ) => Promise<StudyBuddyEmailAccess>,
  dependencies: StudyBuddyEmailBrokerDependencies = {},
): StudyBuddyEmailReadBroker {
  const createClient = dependencies.createClient ?? defaultCreateClient;
  const parseMessage = dependencies.parseMessage ?? defaultParseMessage;
  const webmail =
    dependencies.webmailRuntime ??
    createStudyBuddyWebmailRuntime({
      profiles: [createSogoWebmailProfile(), createRoundcubeWebmailProfile()],
    });

  const withMailbox = async <T>(
    access: StudyBuddyImapAccess,
    requestedFolder: string | undefined,
    operation: (client: ImapClientLike, mailbox: MailboxObject, folder: string) => Promise<T>,
  ): Promise<T> => {
    const folder = resolveFolder(requestedFolder, access.folders);
    const client = createClient({
      host: access.host,
      port: access.port,
      secure: true,
      auth: { user: access.username, pass: access.password },
      disableAutoIdle: true,
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      maxLiteralSize: MAX_MESSAGE_BYTES + 1024 * 1024,
      maxResponseSize: MAX_MESSAGE_BYTES + 2 * 1024 * 1024,
    });
    try {
      await client.connect();
      // EXAMINE/readOnly prevents flag mutations at the mailbox level. ImapFlow also
      // generates BODY.PEEK for every source/bodyParts request below.
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      if (mailbox.readOnly !== true) {
        throw new Error("IMAP server did not confirm a read-only mailbox.");
      }
      return await operation(client, mailbox, folder);
    } finally {
      client.close();
    }
  };

  const listMessages = async (input: StudyBuddyListEmailMessagesInput) => {
    const access = await resolveAccess(input.sourceId, "read");
    if (access.transport === "webmail") return webmail.list(access, input);
    return queryPageWithAccess(access, input, input.unreadOnly ? { seen: false } : { all: true });
  };

  const searchMessages = async (input: StudyBuddySearchEmailMessagesInput) => {
    const access = await resolveAccess(input.sourceId, "read");
    if (access.transport === "webmail")
      return webmail.list(access, { ...input, query: input.query });
    return queryPageWithAccess(access, input, { text: input.query });
  };

  const readMessage = async (
    input: StudyBuddyReadEmailMessageInput,
  ): Promise<StudyBuddyReadEmailMessageResult> => {
    const access = await resolveAccess(input.sourceId, "read");
    if (access.transport === "webmail") return webmail.read(access, input);
    return withMailbox(access, input.folder, async (client, mailbox, folder) => {
      const uid = decodeMessageId(input.messageId, mailbox.uidValidity);
      return readMessageFromClient(input.sourceId, folder, mailbox, client, uid, parseMessage);
    });
  };

  const readContext: StudyBuddyEmailReadBroker["readContext"] = async (input) => {
    const access = await resolveAccess(input.sourceId, "read");
    if (access.transport === "webmail") return webmail.readContext(access, input);
    return withMailbox(access, input.folder, async (client, mailbox, folder) => {
      const query = input.query?.trim();
      const matches =
        (await client.search(query ? { text: query } : { all: true }, { uid: true })) || [];
      const selected = matches
        .slice()
        .sort((left, right) => right - left)
        .slice(0, Math.min(Math.max(input.limit ?? 3, 1), 10));
      const results: StudyBuddyReadEmailMessageResult[] = [];
      for (const uid of selected) {
        results.push(
          await readMessageFromClient(input.sourceId, folder, mailbox, client, uid, parseMessage),
        );
      }
      return results;
    });
  };

  const testConnection = async (sourceId: string): Promise<{ senderEmail?: string }> => {
    const access = await resolveAccess(sourceId, "test");
    if (access.transport === "webmail") return webmail.test(access);
    await withMailbox(access, undefined, async () => undefined);
    return /^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/.test(access.username.trim())
      ? { senderEmail: access.username.trim() }
      : {};
  };

  const sendExact = async (message: StudyBuddyEmailSendApprovalPayload): Promise<void> => {
    const access = await resolveAccess(message.sourceId, "send");
    if (
      !access.senderEmail ||
      access.senderEmail.toLowerCase() !== message.from.address.toLowerCase()
    ) {
      throw new Error("The approved sender does not match the connected email account.");
    }
    if (access.transport !== "webmail") {
      throw new Error(
        "This email account can be read, but an outgoing email service is not configured.",
      );
    }
    await webmail.sendExact(access, message);
  };

  return { listMessages, searchMessages, readMessage, readContext, testConnection, sendExact };

  async function queryPageWithAccess(
    access: StudyBuddyImapAccess,
    input: StudyBuddyListEmailMessagesInput | StudyBuddySearchEmailMessagesInput,
    search: SearchObject,
  ): Promise<StudyBuddyEmailMessagePage> {
    return withMailbox(access, input.folder, async (client, mailbox, folder) => {
      const cursor = decodeCursor(input.cursor);
      assertCursorMailbox(cursor, mailbox);
      const matches = (await client.search(search, { uid: true })) || [];
      const beforeUid = cursor?.beforeUid ?? Number.POSITIVE_INFINITY;
      const eligible = matches.filter((uid) => uid < beforeUid).sort((left, right) => right - left);
      const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const selected = eligible.slice(0, limit);
      const hasMore = eligible.length > selected.length;
      if (selected.length === 0) return { sourceId: input.sourceId, messages: [] };
      const fetched = await client.fetchAll(
        selected,
        { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true },
        { uid: true },
      );
      const byUid = new Map(fetched.map((message) => [message.uid, message]));
      const messages = selected.flatMap((uid) => {
        const message = byUid.get(uid);
        return message ? [toSummary(message, mailbox.uidValidity, folder)] : [];
      });
      return {
        sourceId: input.sourceId,
        messages,
        ...(hasMore
          ? { nextCursor: encodeCursor(mailbox.uidValidity, selected[selected.length - 1]!) }
          : {}),
      };
    });
  }
}

async function readMessageFromClient(
  sourceId: string,
  folder: string,
  mailbox: MailboxObject,
  client: ImapClientLike,
  uid: number,
  parseMessage: (source: Buffer) => Promise<ParsedEmail>,
): Promise<StudyBuddyReadEmailMessageResult> {
  const metadata = await client.fetchOne(
    uid,
    { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true },
    { uid: true },
  );
  if (!metadata) throw new Error("Email message was not found.");
  if ((metadata.size ?? 0) > MAX_MESSAGE_BYTES) {
    throw new Error("Email message exceeds the safe 8 MiB reading limit.");
  }
  const seenBefore = hasSeenFlag(metadata.flags);
  // ImapFlow maps source:true to BODY.PEEK[], so this fetch does not add \\Seen.
  const content = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!content || !content.source) throw new Error("Email message content is unavailable.");
  if (content.source.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("Email message exceeds the safe 8 MiB reading limit.");
  }
  const parsed = await parseMessage(content.source);
  const flagsAfter = await client.fetchOne(uid, { flags: true }, { uid: true });
  if (!flagsAfter) throw new Error("Email message disappeared while it was being read.");
  const seenAfter = hasSeenFlag(flagsAfter.flags);
  const sanitizedText = sanitizeText(parsed.text ?? "");
  const sanitizedHtml = parsed.html ? sanitizeMessageHtml(parsed.html) : undefined;
  return {
    sourceId,
    message: toSummary(metadata, mailbox.uidValidity, folder, sanitizedText),
    cc: addresses(metadata.envelope?.cc, 512),
    replyTo: addresses(metadata.envelope?.replyTo, 128),
    body: {
      sanitizedText: sanitizedText.value,
      ...(sanitizedHtml?.value ? { sanitizedHtml: sanitizedHtml.value } : {}),
      truncated: sanitizedText.truncated || Boolean(sanitizedHtml?.truncated),
    },
    seenState: {
      seenBefore,
      seenAfter,
      preserved: seenBefore === seenAfter,
    },
  };
}

function defaultCreateClient(options: ImapFlowOptions): ImapClientLike {
  return new ImapFlow(options);
}

async function defaultParseMessage(source: Buffer): Promise<ParsedEmail> {
  return simpleParser(source, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
}

function resolveFolder(requested: string | undefined, allowedFolders: readonly string[]): string {
  const configured = allowedFolders.length > 0 ? allowedFolders : [DEFAULT_FOLDER];
  const folder = (requested ?? configured[0] ?? DEFAULT_FOLDER).trim();
  const allowed = configured.some(
    (entry) => entry.toLocaleLowerCase() === folder.toLocaleLowerCase(),
  );
  if (!allowed) throw new Error("Email folder is outside this source's configured scope.");
  return (
    configured.find((entry) => entry.toLocaleLowerCase() === folder.toLocaleLowerCase()) ?? folder
  );
}

function toSummary(
  message: FetchMessageObject,
  uidValidity: bigint,
  folder: string,
  body?: { readonly value: string },
): StudyBuddyEmailMessageSummary {
  const envelope = message.envelope;
  return {
    messageId: encodeMessageId(uidValidity, message.uid),
    ...(message.threadId ? { threadId: truncate(message.threadId, 512) } : {}),
    folder,
    subject: truncate(envelope?.subject ?? "(No subject)", 2_000),
    from: addresses(envelope?.from, 128),
    to: addresses(envelope?.to, 512),
    ...(envelope?.date ? { sentAt: toIso(envelope.date) } : {}),
    ...(message.internalDate ? { receivedAt: toIso(message.internalDate) } : {}),
    sanitizedPreview: truncate(preview(body?.value ?? ""), 4_000),
    isSeen: hasSeenFlag(message.flags),
    hasAttachments: hasAttachment(message.bodyStructure),
  };
}

function addresses(
  values: MessageAddressObject[] | undefined,
  limit: number,
): StudyBuddyEmailAddress[] {
  return (values ?? []).slice(0, limit).flatMap((value) => {
    const address = value.address?.trim();
    if (!address) return [];
    return [
      {
        ...(value.name ? { name: truncate(value.name, 320) } : {}),
        address: truncate(address, 320),
      },
    ];
  });
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (
    node.disposition?.toLocaleLowerCase() === "attachment" ||
    Boolean(node.dispositionParameters?.filename) ||
    Boolean(node.parameters?.name)
  ) {
    return true;
  }
  return node.childNodes?.some(hasAttachment) ?? false;
}

function hasSeenFlag(flags: Set<string> | undefined): boolean {
  return flags?.has("\\Seen") ?? false;
}

function sanitizeText(value: string): { value: string; truncated: boolean } {
  const cleaned = value.replaceAll(String.fromCodePoint(0), "").replace(/\r\n?/g, "\n");
  return { value: truncate(cleaned, MAX_TEXT_LENGTH), truncated: cleaned.length > MAX_TEXT_LENGTH };
}

function sanitizeMessageHtml(value: string): { value: string; truncated: boolean } {
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

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

interface EmailCursor {
  readonly uidValidity: string;
  readonly beforeUid: number;
}

function encodeCursor(uidValidity: bigint, beforeUid: number): string {
  return Buffer.from(JSON.stringify({ uidValidity: uidValidity.toString(), beforeUid })).toString(
    "base64url",
  );
}

function decodeCursor(value: string | undefined): EmailCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as EmailCursor;
    if (!/^\d+$/.test(parsed.uidValidity) || !Number.isSafeInteger(parsed.beforeUid))
      throw new Error();
    return parsed;
  } catch {
    throw new Error("Email page cursor is invalid.");
  }
}

function assertCursorMailbox(cursor: EmailCursor | undefined, mailbox: MailboxObject): void {
  if (cursor && cursor.uidValidity !== mailbox.uidValidity.toString()) {
    throw new Error("Email mailbox changed; restart this result page.");
  }
}

function encodeMessageId(uidValidity: bigint, uid: number): string {
  return Buffer.from(`${uidValidity.toString()}:${uid}`).toString("base64url");
}

function decodeMessageId(value: string, uidValidity: bigint): number {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const match = /^(\d+):(\d+)$/.exec(decoded);
    if (!match || match[1] !== uidValidity.toString()) throw new Error();
    const uid = Number(match[2]);
    if (!Number.isSafeInteger(uid) || uid < 1) throw new Error();
    return uid;
  } catch {
    throw new Error("Email message identifier is stale or invalid.");
  }
}
