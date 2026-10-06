import {
  StudyBuddyListEmailMessagesInput,
  StudyBuddyReadEmailMessageInput,
  StudyBuddySearchEmailMessagesInput,
  StudyBuddySourceId,
  type StudyBuddyEmailAddress,
  type StudyBuddyEmailMessageSummary,
  type StudyBuddySourceBlock,
  type StudyBuddySourceInventory,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { StudyBuddySourcePlatform } from "./sourcePlatform.ts";
import type { StudyBuddyWorkflowResult } from "./workflowBroker.ts";

type EmailToolRequest =
  | { readonly op: "inventory" }
  | ({ readonly op: "list" } & StudyBuddyListEmailMessagesInput)
  | ({ readonly op: "search" } & StudyBuddySearchEmailMessagesInput)
  | ({ readonly op: "read" } & StudyBuddyReadEmailMessageInput);

const ERROR_MESSAGES = {
  "invalid-request": "Use email with one JSON object: inventory, list, search, or read.",
  "invalid-selection": "The selected sources must all be existing email sources.",
  "source-not-selected": "This email account is outside the selected source scope.",
  "source-not-found": "This email account is not configured.",
  "source-disabled": "This email account is disabled in Study Buddy settings.",
  "reading-disabled": "Email reading is disabled for this account in Study Buddy settings.",
  "login-required": "Sign-in details are not configured for this email account.",
  "authentication-failed": "The email service rejected sign-in. Check the account connection.",
  "folder-not-allowed": "This folder is outside the email account's configured scope.",
  "message-not-found": "The requested email message is no longer available.",
  "read-state-unverified":
    "Email content was withheld because its read status could not be preserved.",
  "service-unavailable": "The email service could not complete this read-only request.",
} as const;
type EmailToolErrorCode = keyof typeof ERROR_MESSAGES;

class EmailToolError extends Error {
  readonly code: EmailToolErrorCode;

  constructor(code: EmailToolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

const MAX_REQUEST_LENGTH = 32_768;
const MAX_ACCOUNTS = 100;
const MAX_ADDRESSES = 20;
const MAX_BODY_LENGTH = 16_000;
const decodeList = Schema.decodeUnknownSync(StudyBuddyListEmailMessagesInput);
const decodeSearch = Schema.decodeUnknownSync(StudyBuddySearchEmailMessagesInput);
const decodeRead = Schema.decodeUnknownSync(StudyBuddyReadEmailMessageInput);
const decodeSourceId = Schema.decodeUnknownSync(StudyBuddySourceId);

function invalidRequest(): never {
  throw new EmailToolError("invalid-request");
}

/** Strictly expose existing read-only contracts; no URLs, credentials or mutations. */
export function parseStudyBuddyEmailToolRequest(args: readonly string[]): EmailToolRequest {
  if (
    args.length !== 2 ||
    args[0] !== "email" ||
    !args[1] ||
    args[1].length > MAX_REQUEST_LENGTH ||
    args[1].includes("\0")
  )
    invalidRequest();
  let value: unknown;
  try {
    value = JSON.parse(args[1]);
  } catch {
    invalidRequest();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest();
  const request = value as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    inventory: ["op"],
    list: ["op", "sourceId", "folder", "cursor", "limit", "unreadOnly"],
    search: ["op", "sourceId", "folder", "cursor", "limit", "query"],
    read: ["op", "sourceId", "folder", "messageId"],
  };
  if (
    typeof request.op !== "string" ||
    !Object.hasOwn(fields, request.op) ||
    Object.keys(request).some((key) => !fields[request.op as string]!.includes(key)) ||
    Object.values(request).some(
      (field) =>
        typeof field === "string" &&
        ["\0", "\r", "\n"].some((character) => field.includes(character)),
    )
  )
    invalidRequest();
  const { op, ...input } = request;
  try {
    switch (op) {
      case "inventory":
        return { op };
      case "list":
        return { op, ...decodeList(input) };
      case "search":
        return { op, ...decodeSearch(input) };
      case "read":
        return { op, ...decodeRead(input) };
      default:
        return invalidRequest();
    }
  } catch {
    return invalidRequest();
  }
}

function safeText(value: string, limit: number): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127)
      continue;
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function addresses(values: readonly StudyBuddyEmailAddress[]) {
  return values.slice(0, MAX_ADDRESSES).map((value) => ({
    ...(value.name ? { name: safeText(value.name, 160) } : {}),
    address: safeText(value.address, 320),
  }));
}

function summary(message: StudyBuddyEmailMessageSummary) {
  return {
    messageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    folder: message.folder,
    subject: safeText(message.subject, 600),
    from: addresses(message.from),
    to: addresses(message.to),
    ...(message.sentAt ? { sentAt: message.sentAt } : {}),
    ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
    sanitizedPreview: safeText(message.sanitizedPreview, 600),
    isSeen: message.isSeen,
    hasAttachments: message.hasAttachments,
    metadataTruncated:
      message.subject.length > 600 ||
      message.sanitizedPreview.length > 600 ||
      message.from.length > MAX_ADDRESSES ||
      message.to.length > MAX_ADDRESSES ||
      [...message.from, ...message.to].some((value) => (value.name?.length ?? 0) > 160),
  };
}

function selectedSources(inventory: StudyBuddySourceInventory, sourceIds?: readonly string[]) {
  if (sourceIds === undefined) return inventory.sources.filter((source) => source.kind === "email");
  if (sourceIds.length > MAX_ACCOUNTS) throw new EmailToolError("invalid-selection");
  const selected = new Set<string>();
  for (const id of sourceIds) {
    try {
      decodeSourceId(id);
    } catch {
      throw new EmailToolError("invalid-selection");
    }
    if (!inventory.sources.some((source) => source.id === id && source.kind === "email"))
      throw new EmailToolError("invalid-selection");
    selected.add(id);
  }
  return inventory.sources.filter((source) => selected.has(source.id));
}

function allowedFolders(source: StudyBuddySourceBlock): readonly string[] {
  return source.scope.mailFolders.length ? source.scope.mailFolders : ["INBOX"];
}

function accountStatus(source: StudyBuddySourceBlock, inventory: StudyBuddySourceInventory) {
  const connection = inventory.connections.find((entry) => entry.id === source.connectionId);
  const canRead =
    source.policy.authenticatedReads === "allowed" &&
    source.capabilities.includes("mail.message.read");
  const authState = connection?.auth.state ?? "not-configured";
  const status: "ready" | EmailToolErrorCode = !source.enabled
    ? "source-disabled"
    : !canRead
      ? "reading-disabled"
      : authState !== "configured"
        ? "login-required"
        : "ready";
  return {
    sourceId: source.id,
    sourceLabel: safeText(source.label, 200),
    kind: "email" as const,
    enabled: source.enabled,
    authState,
    canRead,
    folders: allowedFolders(source),
    status,
  };
}

function failureCode(cause: unknown): EmailToolErrorCode {
  if (cause instanceof EmailToolError) return cause.code;
  if (!cause || typeof cause !== "object") return "service-unavailable";
  const error = cause as { authenticationFailed?: unknown; code?: unknown; message?: unknown };
  if (
    error.authenticationFailed === true ||
    error.code === "EAUTH" ||
    error.message === "SOGo sign-in failed." ||
    error.message === "Roundcube sign-in failed."
  )
    return "authentication-failed";
  // Match only broker-owned static messages; never disclose transport messages.
  switch (error.message) {
    case "Email sign-in details are not configured.":
      return "login-required";
    case "Email reading is turned off for this source. Open its settings to allow it.":
      return "reading-disabled";
    case "Email source is disabled.":
      return "source-disabled";
    case "Email folder is outside this source's configured scope.":
      return "folder-not-allowed";
    case "Email message was not found.":
    case "Email message disappeared while it was being read.":
    case "SOGo message was not found.":
    case "Roundcube message was not found while verifying read state.":
      return "message-not-found";
    case "IMAP server did not confirm a read-only mailbox.":
    case "Webmail changed the message read state and restoration could not be verified.":
      return "read-state-unverified";
    default:
      return "service-unavailable";
  }
}

function result(value: unknown, exitCode = 0): StudyBuddyWorkflowResult {
  return { exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

/** The authenticated server owns access and sign-in; this adapter only returns evidence. */
export async function executeStudyBuddyEmailTool(
  input: { readonly args: readonly string[]; readonly sourceIds?: readonly string[] },
  platform: Pick<StudyBuddySourcePlatform, "getInventory" | "email">,
): Promise<StudyBuddyWorkflowResult> {
  try {
    const request = parseStudyBuddyEmailToolRequest(input.args);
    const inventory = await platform.getInventory();
    const sources = selectedSources(inventory, input.sourceIds);
    if (request.op === "inventory") {
      return result({
        status: "ok",
        op: request.op,
        untrusted: true,
        accounts: sources.slice(0, MAX_ACCOUNTS).map((source) => accountStatus(source, inventory)),
        totalAccounts: sources.length,
        truncated: sources.length > MAX_ACCOUNTS,
      });
    }
    if (input.sourceIds !== undefined && !input.sourceIds.includes(request.sourceId))
      throw new EmailToolError("source-not-selected");
    const source = sources.find((entry) => entry.id === request.sourceId);
    if (!source) throw new EmailToolError("source-not-found");
    const account = accountStatus(source, inventory);
    if (account.status !== "ready") throw new EmailToolError(account.status);
    const requestedFolder = request.folder ?? account.folders[0]!;
    const folder = account.folders.find(
      (entry) => entry.toLowerCase() === requestedFolder.toLowerCase(),
    );
    if (!folder) throw new EmailToolError("folder-not-allowed");
    if (request.op === "read") {
      const read = await platform.email.readMessage({
        sourceId: source.id,
        folder,
        messageId: request.messageId,
      });
      if (
        read.seenState.preserved !== true ||
        read.seenState.seenBefore !== read.seenState.seenAfter ||
        read.message.isSeen !== read.seenState.seenBefore ||
        read.sourceId !== source.id ||
        read.message.messageId !== request.messageId ||
        read.message.folder !== folder
      )
        throw new EmailToolError("read-state-unverified");
      const sanitizedText = safeText(read.body.sanitizedText, MAX_BODY_LENGTH);
      // Some MIME messages contain an empty plain-text part alongside useful
      // sanitized HTML. Preserve that evidence rather than reporting no body.
      const sanitizedHtml =
        !sanitizedText.trim() && read.body.sanitizedHtml
          ? safeText(read.body.sanitizedHtml, MAX_BODY_LENGTH)
          : undefined;
      return result({
        status: "ok",
        op: request.op,
        untrusted: true,
        sourceId: source.id,
        sourceLabel: account.sourceLabel,
        folder,
        message: summary(read.message),
        cc: addresses(read.cc),
        replyTo: addresses(read.replyTo),
        body: {
          sanitizedText,
          ...(sanitizedHtml ? { sanitizedHtml } : {}),
          truncated:
            read.body.truncated ||
            read.body.sanitizedText.length > MAX_BODY_LENGTH ||
            Boolean(sanitizedHtml && read.body.sanitizedHtml!.length > MAX_BODY_LENGTH),
        },
        addressListsTruncated:
          read.cc.length > MAX_ADDRESSES || read.replyTo.length > MAX_ADDRESSES,
        seenState: read.seenState,
      });
    }
    const { op: _op, ...pageInput } = request;
    const page =
      request.op === "search"
        ? await platform.email.searchMessages({ ...pageInput, folder, query: request.query })
        : await platform.email.listMessages({ ...pageInput, folder });
    if (
      page.sourceId !== source.id ||
      page.messages.length > (request.limit ?? 25) ||
      page.messages.some((message) => message.folder !== folder)
    )
      throw new EmailToolError("service-unavailable");
    return result({
      status: "ok",
      op: request.op,
      untrusted: true,
      sourceId: source.id,
      sourceLabel: account.sourceLabel,
      folder,
      messages: page.messages.map(summary),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      complete: !page.nextCursor,
    });
  } catch (cause) {
    const code = failureCode(cause);
    return result({ status: "error", code, message: ERROR_MESSAGES[code] }, 1);
  }
}
