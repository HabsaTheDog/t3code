// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Provider receipt polling is a bounded Promise adapter.
// @effect-diagnostics globalDate:off -- A short provider receipt window prevents duplicate retries.
import { Buffer } from "node:buffer";
import { assertPublicHttpsUrl } from "../moodle/browserSecurity.ts";
import type { StudyBuddyEmailSendApprovalPayload } from "@t3tools/contracts";
import { simpleParser } from "mailparser";
import type {
  WebmailMessageRecord,
  WebmailProfileSession,
  WebmailProviderProfile,
} from "./webmailProfileRuntime.ts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface WebmailProfileHttpDependencies {
  readonly fetch?: typeof fetch;
  readonly validateUrl?: (url: string) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

interface ProviderSession extends WebmailProfileSession {
  readonly http: CookieSession;
  readonly user?: string;
  readonly senderEmail?: string;
  token?: string;
}

export function createSogoWebmailProfile(
  dependencies: WebmailProfileHttpDependencies = {},
): WebmailProviderProfile {
  return {
    id: "sogo",
    readStateGuarantee: "verify-and-restore",
    async login(access) {
      const http = await CookieSession.create(access.baseUrl, dependencies);
      const response = await http.request("connect", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          userName: access.username,
          password: access.password,
          rememberLogin: 0,
        }),
      });
      const payload = parseJson(await readText(response)) as Record<string, unknown>;
      if (!response.ok || typeof payload.username !== "string" || !payload.username) {
        throw new Error("SOGo sign-in failed.");
      }
      return {
        profileId: "sogo",
        http,
        user: payload.username,
        ...(access.senderEmail ? { senderEmail: access.senderEmail } : {}),
      } satisfies ProviderSession;
    },
    async resolveSenderEmail(genericSession) {
      const session = asSession(genericSession, "sogo");
      if (!session.user) throw new Error("SOGo session is incomplete.");
      const response = await session.http.request(
        `so/${encodeURIComponent(session.user)}/Mail/mailAccounts`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      if (!response.ok) return undefined;
      return parseSogoSenderEmail(parseJson(await readText(response)));
    },
    async list(genericSession, input) {
      const session = asSession(genericSession, "sogo");
      const url = sogoFolderUrl(session, input.folder, "view");
      const filters = input.query
        ? [{ searchBy: "contains", searchInput: input.query, negative: false }]
        : [];
      const response = await session.http.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sortingAttributes: { match: "AND", sort: "arrival", asc: false, noHeaders: false },
          ...(input.unreadOnly ? { unseenOnly: 1 } : {}),
          ...(filters.length ? { filters } : {}),
        }),
      });
      if (!response.ok) throw new Error("SOGo could not list this mailbox.");
      const payload = parseJson(await readText(response)) as {
        headers?: unknown;
        uids?: unknown;
      };
      const offset = parseOffset(input.cursor);
      const allUids = Array.isArray(payload.uids) ? payload.uids.map(String) : [];
      const selectedUids = allUids.slice(offset, offset + input.limit);
      let records = parseSogoHeaders(payload.headers, input.folder).filter((record) =>
        selectedUids.includes(record.id),
      );
      if (records.length !== selectedUids.length && selectedUids.length) {
        const headersResponse = await session.http.request(
          sogoFolderUrl(session, input.folder, "headers"),
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ uids: selectedUids }),
          },
        );
        if (!headersResponse.ok) throw new Error("SOGo could not fetch mailbox headers.");
        records = parseSogoHeaders(parseJson(await readText(headersResponse)), input.folder);
      }
      if (allUids.length === 0) {
        records = parseSogoHeaders(payload.headers, input.folder).slice(0, input.limit);
      }
      return {
        records,
        ...(offset + selectedUids.length < allUids.length
          ? { nextCursor: String(offset + selectedUids.length) }
          : {}),
      };
    },
    async inspectSeen(genericSession, reference) {
      const session = asSession(genericSession, "sogo");
      const response = await session.http.request(
        sogoFolderUrl(session, reference.folder, "headers"),
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ uids: [reference.id] }),
        },
      );
      if (!response.ok) throw new Error("SOGo could not verify the message read state.");
      const payload = parseJson(await readText(response));
      const headers = Array.isArray(payload)
        ? payload
        : (payload as { headers?: unknown } | null)?.headers;
      const record = parseSogoHeaders(headers, reference.folder).find(
        (entry) => entry.id === reference.id,
      );
      if (!record) throw new Error("SOGo message was not found.");
      return record.isSeen;
    },
    async fetchRaw(genericSession, reference) {
      const session = asSession(genericSession, "sogo");
      const response = await session.http.request(
        sogoFolderUrl(session, reference.folder, `${encodeURIComponent(reference.id)}/export`),
        { method: "GET", headers: { accept: "message/rfc822,text/plain" } },
      );
      if (!response.ok) throw new Error("SOGo message content is unavailable.");
      return readBuffer(response);
    },
    async restoreSeen(genericSession, reference, seen) {
      const session = asSession(genericSession, "sogo");
      const action = seen ? "markMessageRead" : "markMessageUnread";
      const response = await session.http.request(
        sogoFolderUrl(session, reference.folder, `${encodeURIComponent(reference.id)}/${action}`),
        { method: "GET", headers: { accept: "application/json,text/plain" } },
      );
      if (!response.ok) throw new Error("SOGo could not restore the message read state.");
      await discard(response);
    },
    async sendExact(genericSession, message) {
      const session = asSession(genericSession, "sogo");
      if (!session.user) throw new Error("SOGo session is incomplete.");
      assertMatchingFrom(session.senderEmail ?? "", message);
      const sentFolder = await resolveSogoSentFolder(session);
      if (
        await hasRecentSogoSentCopy(
          session,
          sentFolder,
          message,
          dependencies.now?.() ?? Date.now(),
        )
      ) {
        return;
      }
      const composeResponse = await session.http.request(
        `so/${encodeURIComponent(session.user)}/Mail/0/compose`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      const compose = parseJson(await readText(composeResponse)) as Record<string, unknown>;
      if (
        !composeResponse.ok ||
        typeof compose.accountId !== "string" ||
        typeof compose.mailboxPath !== "string" ||
        typeof compose.draftId !== "string"
      ) {
        throw new Error("SOGo could not prepare this email.");
      }
      const draftPath = sogoDraftPath(
        session,
        compose.accountId,
        compose.mailboxPath,
        compose.draftId,
      );
      const editResponse = await session.http.request(`${draftPath}/edit`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const editable = parseJson(await readText(editResponse)) as Record<string, unknown>;
      const providerFrom = typeof editable.from === "string" ? editable.from : "";
      assertMatchingFrom(providerFrom, message);
      const sentBefore = new Set(await listSogoFolderUids(session, sentFolder));
      const response = await session.http.request(`${draftPath}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ...editable,
          from: providerFrom,
          to: message.to.map(formatApprovalAddress),
          cc: message.cc.map(formatApprovalAddress),
          bcc: message.bcc.map(formatApprovalAddress),
          subject: message.subject,
          text: message.bodyText,
          isHTML: false,
        }),
      });
      const result = parseJson(await readText(response)) as Record<string, unknown>;
      if (!response.ok || result.status !== "success") {
        throw new Error("SOGo did not confirm that the email was sent.");
      }
      await verifySogoSentCopy(session, sentFolder, sentBefore, message, dependencies.wait);
    },
    async close() {},
  };
}

export function createRoundcubeWebmailProfile(
  dependencies: WebmailProfileHttpDependencies = {},
): WebmailProviderProfile {
  return {
    id: "roundcube",
    readStateGuarantee: "verify-and-restore",
    async login(access) {
      const http = await CookieSession.create(access.baseUrl, dependencies);
      const loginPage = await http.request("", { method: "GET", headers: { accept: "text/html" } });
      const loginHtml = await readText(loginPage);
      const token = extractRoundcubeToken(loginHtml);
      if (!loginPage.ok || !token)
        throw new Error("Roundcube login page did not provide a request token.");
      const body = new URLSearchParams({
        _task: "login",
        _action: "login",
        _timezone: "auto",
        _url: "",
        _token: token,
        _user: access.username,
        _pass: access.password,
      });
      const response = await http.request(
        "",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
          body,
        },
        true,
      );
      const html = await readText(response);
      const nextToken = extractRoundcubeToken(html) ?? token;
      if (!response.ok || /rcmloginuser|name=["']_pass["']/i.test(html)) {
        throw new Error("Roundcube sign-in failed.");
      }
      return { profileId: "roundcube", http, token: nextToken } satisfies ProviderSession;
    },
    async list(genericSession, input) {
      const session = asSession(genericSession, "roundcube");
      return roundcubeList(session, input);
    },
    async inspectSeen(genericSession, reference) {
      const session = asSession(genericSession, "roundcube");
      const locator = parseRoundcubeLocator(reference.locator);
      const page = await roundcubeList(session, {
        folder: reference.folder,
        limit: 100,
        ...(locator.query ? { query: locator.query } : {}),
        ...(locator.unreadOnly ? { unreadOnly: true } : {}),
        ...(locator.page ? { cursor: String(locator.page) } : {}),
      });
      const record = page.records.find((entry) => entry.id === reference.id);
      if (!record) throw new Error("Roundcube message was not found while verifying read state.");
      return record.isSeen;
    },
    async fetchRaw(genericSession, reference) {
      const session = asSession(genericSession, "roundcube");
      const response = await session.http.request(
        roundcubeUrl({
          _task: "mail",
          _action: "viewsource",
          _uid: reference.id,
          _mbox: reference.folder,
          ...(session.token ? { _token: session.token } : {}),
        }),
        { method: "GET", headers: { accept: "message/rfc822,text/plain" } },
      );
      if (!response.ok) throw new Error("Roundcube message content is unavailable.");
      return readBuffer(response);
    },
    async restoreSeen(genericSession, reference, seen) {
      const session = asSession(genericSession, "roundcube");
      const response = await session.http.request(
        roundcubeUrl({ _task: "mail", _action: "mark" }),
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            _uid: reference.id,
            _mbox: reference.folder,
            _flag: seen ? "read" : "unread",
            _quiet: "1",
            ...(session.token ? { _token: session.token } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error("Roundcube could not restore the message read state.");
      await discard(response);
    },
    async sendExact(genericSession, message) {
      const session = asSession(genericSession, "roundcube");
      const composeResponse = await session.http.request(
        roundcubeUrl({
          _task: "mail",
          _action: "compose",
          ...(session.token ? { _token: session.token } : {}),
        }),
        { method: "GET", headers: { accept: "text/html" } },
        true,
      );
      const html = await readText(composeResponse);
      const composeId = extractInputValue(html, "_id");
      const token = extractRoundcubeToken(html) ?? session.token;
      const selectedFrom = extractSelectedOption(html, "_from");
      const providerFrom = selectedFrom?.value ?? extractInputValue(html, "_from");
      const providerFromLabel = selectedFrom?.label ?? providerFrom;
      if (!composeResponse.ok || !composeId || !token || !providerFrom || !providerFromLabel) {
        throw new Error("Roundcube could not prepare this email.");
      }
      assertMatchingFrom(providerFromLabel, message);
      const response = await session.http.request(
        roundcubeUrl({ _task: "mail", _action: "send", _framed: "1" }),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
          body: new URLSearchParams({
            _task: "mail",
            _action: "send",
            _id: composeId,
            _token: token,
            _from: providerFrom,
            _to: message.to.map(formatApprovalAddress).join(", "),
            _cc: message.cc.map(formatApprovalAddress).join(", "),
            _bcc: message.bcc.map(formatApprovalAddress).join(", "),
            _subject: message.subject,
            _message: message.bodyText,
            _draft: "",
            _is_html: "0",
            _attachments: "",
          }),
        },
      );
      const result = await readText(response);
      if (
        !response.ok ||
        /(?:display_message|show_message)\([^)]*(?:error|sendingfailed|smtp|invalid)/i.test(
          result,
        ) ||
        !/(?:messagesent|message[^\n]{0,30}sent|confirmation)/i.test(result)
      ) {
        throw new Error("Roundcube did not confirm that the email was sent.");
      }
    },
    async close() {},
  };
}

async function roundcubeList(
  session: ProviderSession,
  input: { folder: string; query?: string; unreadOnly?: boolean; cursor?: string; limit: number },
) {
  const page = parsePositiveInt(input.cursor) ?? 1;
  const action = input.query || input.unreadOnly ? "search" : "list";
  const params: Record<string, string> = {
    _task: "mail",
    _action: action,
    _mbox: input.folder,
    _page: String(page),
    _cols: "subject,from,to,date,size",
    ...(session.token ? { _token: session.token } : {}),
  };
  if (action === "search") {
    params._q = input.query ?? "";
    params._headers = "subject,from,to,cc,body";
    params._filter = input.unreadOnly ? "UNSEEN" : "ALL";
    params._scope = "base";
  } else {
    params._refresh = "1";
  }
  const response = await session.http.request(roundcubeUrl(params), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Roundcube could not list this mailbox.");
  const payload = parseJson(await readText(response)) as {
    exec?: unknown;
    env?: { pagecount?: unknown };
  };
  if (typeof payload.exec !== "string")
    throw new Error("Roundcube returned an invalid mailbox response.");
  const locator = JSON.stringify({
    page,
    ...(input.query ? { query: input.query } : {}),
    ...(input.unreadOnly ? { unreadOnly: true } : {}),
  });
  const records = parseRoundcubeRows(payload.exec, input.folder, locator).slice(0, input.limit);
  const pages = typeof payload.env?.pagecount === "number" ? payload.env.pagecount : page;
  return {
    records,
    ...(action === "list" && page < pages ? { nextCursor: String(page + 1) } : {}),
  };
}

function sogoFolderUrl(session: ProviderSession, folder: string, suffix: string): string {
  if (!session.user) throw new Error("SOGo session is incomplete.");
  return `so/${encodeURIComponent(session.user)}/Mail/0/folder${encodeURIComponent(folder)}/${suffix}`;
}

interface SogoMailboxDescription {
  readonly path?: unknown;
  readonly type?: unknown;
  readonly children?: unknown;
}

async function resolveSogoSentFolder(session: ProviderSession): Promise<string> {
  if (!session.user) throw new Error("SOGo session is incomplete.");
  const response = await session.http.request(
    `so/${encodeURIComponent(session.user)}/Mail/0/view`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  const payload = parseJson(await readText(response)) as { mailboxes?: unknown };
  if (!response.ok || !Array.isArray(payload.mailboxes)) {
    throw new Error("SOGo could not locate the Sent folder.");
  }
  const path = findSogoMailboxPath(payload.mailboxes, "sent");
  if (!path) throw new Error("SOGo did not provide a Sent folder for delivery verification.");
  return path;
}

function findSogoMailboxPath(value: readonly unknown[], type: string): string | undefined {
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const mailbox = raw as SogoMailboxDescription;
    if (mailbox.type === type && typeof mailbox.path === "string" && mailbox.path.trim()) {
      return mailbox.path.trim();
    }
    if (Array.isArray(mailbox.children)) {
      const nested = findSogoMailboxPath(mailbox.children, type);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function listSogoFolderUids(session: ProviderSession, folder: string): Promise<string[]> {
  const response = await session.http.request(sogoFolderUrl(session, folder, "view"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sortingAttributes: { match: "AND", sort: "arrival", asc: false, noHeaders: true },
    }),
  });
  const payload = parseJson(await readText(response)) as { uids?: unknown };
  if (!response.ok || !Array.isArray(payload.uids)) {
    throw new Error("SOGo could not inspect the Sent folder.");
  }
  return payload.uids.map(String);
}

async function verifySogoSentCopy(
  session: ProviderSession,
  folder: string,
  previousUids: ReadonlySet<string>,
  message: StudyBuddyEmailSendApprovalPayload,
  wait: WebmailProfileHttpDependencies["wait"],
): Promise<void> {
  const pause =
    wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await pause(500);
    const currentUids = await listSogoFolderUids(session, folder);
    const newUids = currentUids.filter((uid) => !previousUids.has(uid)).slice(0, 20);
    if (!newUids.length) continue;
    const response = await session.http.request(sogoFolderUrl(session, folder, "headers"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ uids: newUids }),
    });
    if (!response.ok) throw new Error("SOGo could not verify the sent email.");
    const payload = parseJson(await readText(response));
    const headers = Array.isArray(payload)
      ? payload
      : (payload as { headers?: unknown } | null)?.headers;
    const matching = parseSogoHeaders(headers, folder).some((record) =>
      isApprovedSentRecord(record, message),
    );
    if (matching) return;
  }
  throw new Error(
    "SOGo accepted the send request, but the email did not appear in Sent. Study Buddy cannot confirm that it was sent.",
  );
}

async function hasRecentSogoSentCopy(
  session: ProviderSession,
  folder: string,
  message: StudyBuddyEmailSendApprovalPayload,
  now: number,
): Promise<boolean> {
  const uids = (await listSogoFolderUids(session, folder)).slice(0, 30);
  if (!uids.length) return false;
  const response = await session.http.request(sogoFolderUrl(session, folder, "headers"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ uids }),
  });
  if (!response.ok) throw new Error("SOGo could not check for a previous delivery.");
  const payload = parseJson(await readText(response));
  const headers = Array.isArray(payload)
    ? payload
    : (payload as { headers?: unknown } | null)?.headers;
  const candidates = parseSogoHeaders(headers, folder)
    .filter((record) => isApprovedSentRecord(record, message))
    .slice(0, 10);
  for (const candidate of candidates) {
    const rawResponse = await session.http.request(
      sogoFolderUrl(session, folder, `${encodeURIComponent(candidate.id)}/export`),
      { method: "GET", headers: { accept: "message/rfc822,text/plain" } },
    );
    if (!rawResponse.ok) continue;
    const parsed = await simpleParser(await readBuffer(rawResponse), {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    const sentAt = parsed.date?.getTime();
    if (
      sentAt !== undefined &&
      sentAt >= now - 30 * 60_000 &&
      sentAt <= now + 5 * 60_000 &&
      normalizeMailText(parsed.text ?? "") === normalizeMailText(message.bodyText)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeMailText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function isApprovedSentRecord(
  record: WebmailMessageRecord,
  message: StudyBuddyEmailSendApprovalPayload,
): boolean {
  if (record.subject !== message.subject) return false;
  const from = new Set(record.from.map((address) => address.address.toLowerCase()));
  if (!from.has(message.from.address.toLowerCase())) return false;
  const recipients = new Set(record.to.map((address) => address.address.toLowerCase()));
  return [...message.to, ...message.cc].every((address) =>
    recipients.has(address.address.toLowerCase()),
  );
}

function sogoDraftPath(
  session: ProviderSession,
  accountId: string,
  mailboxPath: string,
  draftId: string,
): string {
  const folders = mailboxPath
    .split("/")
    .filter(Boolean)
    .map((part) => `folder${encodeURIComponent(part)}`)
    .join("/");
  if (!session.user || !folders || !accountId || !draftId)
    throw new Error("SOGo returned an invalid draft path.");
  return `so/${encodeURIComponent(session.user)}/Mail/${encodeURIComponent(accountId)}/${folders}/${encodeURIComponent(draftId)}`;
}

function roundcubeUrl(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`;
}

export function parseSogoHeaders(value: unknown, folder: string): WebmailMessageRecord[] {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return [];
  const keys = value[0].map(String);
  return value.slice(1).flatMap((raw) => {
    if (!Array.isArray(raw)) return [];
    const row = Object.fromEntries(keys.map((key, index) => [key, raw[index]]));
    const id = String(row.uid ?? "");
    if (!id) return [];
    return [
      {
        id,
        folder,
        subject: decodeEntities(String(row.Subject ?? "(No subject)")),
        from: parseSogoAddresses(row.From),
        to: parseSogoAddresses(row.To),
        isSeen: sogoBoolean(row.isRead),
        hasAttachments: sogoBoolean(row.hasAttachment),
      },
    ];
  });
}

export function parseSogoSenderEmail(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const rawAccount of value) {
    if (!rawAccount || typeof rawAccount !== "object") continue;
    const identities = (rawAccount as Record<string, unknown>).identities;
    if (!Array.isArray(identities)) continue;
    const candidates = identities
      .filter((identity): identity is Record<string, unknown> =>
        Boolean(identity && typeof identity === "object"),
      )
      .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
    for (const identity of candidates) {
      const email = typeof identity.email === "string" ? identity.email.trim() : "";
      if (/^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/.test(email)) return email;
    }
  }
  return undefined;
}

export function parseRoundcubeRows(
  exec: string,
  folder: string,
  locator: string,
): WebmailMessageRecord[] {
  const results: WebmailMessageRecord[] = [];
  const marker = "this.add_message_row(";
  let offset = 0;
  while ((offset = exec.indexOf(marker, offset)) >= 0) {
    const start = offset + marker.length;
    const end = exec.indexOf(");", start);
    if (end < 0) break;
    try {
      const [uid, cols, flags] = JSON.parse(`[${exec.slice(start, end)}]`) as [
        unknown,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      if ((typeof uid !== "string" && typeof uid !== "number") || !cols || !flags)
        throw new Error();
      results.push({
        id: String(uid),
        folder,
        locator,
        subject: cleanRoundcubeCell(cols.subject),
        from: parseAddressText(cleanRoundcubeCell(cols.from ?? cols.fromto)),
        to: parseAddressText(cleanRoundcubeCell(cols.to)),
        isSeen: Boolean(flags.seen),
        hasAttachments: Boolean(flags.attachment),
      });
    } catch {
      // Ignore malformed plugin-generated rows; never execute Roundcube's JS response.
    }
    offset = end + 2;
  }
  return results;
}

class CookieSession {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #validate: (url: string) => Promise<void>;
  readonly #cookies = new Map<string, string>();

  private constructor(base: URL, dependencies: WebmailProfileHttpDependencies) {
    this.#base = base;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#validate = dependencies.validateUrl ?? ((url) => assertPublicHttpsUrl(url));
  }

  static async create(value: string, dependencies: WebmailProfileHttpDependencies) {
    const base = new URL(value);
    if (base.protocol !== "https:" || base.username || base.password)
      throw new Error("Webmail URL must be credential-free HTTPS.");
    base.hash = "";
    base.search = "";
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    await (dependencies.validateUrl ?? ((url: string) => assertPublicHttpsUrl(url)))(base.href);
    return new CookieSession(base, dependencies);
  }

  async request(path: string, init: RequestInit, follow = false): Promise<Response> {
    let url = new URL(path, this.#base);
    let requestInit = init;
    for (let redirects = 0; redirects < 4; redirects++) {
      if (url.origin !== this.#base.origin)
        throw new Error("Webmail redirected outside its configured origin.");
      await this.#validate(url.href);
      const headers = new Headers(requestInit.headers);
      if (this.#cookies.size)
        headers.set(
          "cookie",
          [...this.#cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        );
      const xsrf = this.#cookies.get("XSRF-TOKEN");
      if (xsrf) headers.set("x-xsrf-token", decodeURIComponent(xsrf));
      const response = await this.#fetch(url, { ...requestInit, headers, redirect: "manual" });
      this.#captureCookies(response.headers);
      if (!follow || response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      url = new URL(location, url);
      requestInit = { method: "GET", headers: { accept: "text/html" } };
    }
    throw new Error("Webmail returned too many redirects.");
  }

  #captureCookies(headers: Headers): void {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const values =
      extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    for (const value of values) {
      const pair = /^([^=;\s]+)=([^;]*)/.exec(value);
      if (pair) this.#cookies.set(pair[1]!, pair[2]!);
    }
  }
}

function asSession(value: WebmailProfileSession, profileId: string): ProviderSession {
  if (value.profileId !== profileId || !("http" in value))
    throw new Error("Webmail session profile mismatch.");
  return value as ProviderSession;
}

async function readBuffer(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES)
    throw new Error("Webmail response exceeds the safe 8 MiB limit.");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Webmail response exceeds the safe 8 MiB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

async function readText(response: Response): Promise<string> {
  return (await readBuffer(response)).toString("utf8");
}

async function discard(response: Response): Promise<void> {
  await readBuffer(response);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Webmail returned an invalid response.");
  }
}

function extractRoundcubeToken(html: string): string | undefined {
  return (
    /name=["']_token["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1] ??
    /["']request_token["']\s*:\s*["']([^"']+)["']/i.exec(html)?.[1]
  );
}

function extractInputValue(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<input[^>]*name=["']${escaped}["'][^>]*>`, "i").exec(html)?.[0];
  return tag ? /value=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
}

function extractSelectedOption(
  html: string,
  name: string,
): { value: string; label: string } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const select = new RegExp(
    `<select[^>]*name=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  ).exec(html)?.[1];
  if (!select) return undefined;
  const tag =
    /<option[^>]*selected[^>]*value=["'][^"']+["'][^>]*>[\s\S]*?<\/option>/i.exec(select)?.[0] ??
    /<option[^>]*value=["'][^"']+["'][^>]*>[\s\S]*?<\/option>/i.exec(select)?.[0];
  if (!tag) return undefined;
  const value = /value=["']([^"']+)["']/i.exec(tag)?.[1];
  if (!value) return undefined;
  return { value, label: decodeEntities(tag.replace(/<[^>]*>/g, " ").trim()) };
}

function formatApprovalAddress(address: {
  readonly name?: string;
  readonly address: string;
}): string {
  return address.name
    ? `${address.name.replace(/[<>]/g, "")} <${address.address}>`
    : address.address;
}

function assertMatchingFrom(
  providerFrom: string,
  message: StudyBuddyEmailSendApprovalPayload,
): void {
  const providerAddress = /([^\s<>]+@[^\s<>]+)/.exec(providerFrom)?.[1]?.toLowerCase();
  if (!providerAddress || providerAddress !== message.from.address.toLowerCase()) {
    throw new Error("The approved sender does not match the connected email account.");
  }
}

function parseRoundcubeLocator(value: string | undefined): {
  page?: number;
  query?: string;
  unreadOnly?: boolean;
} {
  if (!value) return { page: 1 };
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    return {
      ...(typeof data.page === "number" && Number.isSafeInteger(data.page)
        ? { page: data.page }
        : {}),
      ...(typeof data.query === "string" ? { query: data.query } : {}),
      ...(data.unreadOnly === true ? { unreadOnly: true } : {}),
    };
  } catch {
    throw new Error("Roundcube message locator is invalid.");
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Email page cursor is invalid.");
  return result;
}

function parseOffset(value: string | undefined): number {
  if (!value) return 0;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Email page cursor is invalid.");
  return result;
}

function cleanRoundcubeCell(value: unknown): string {
  return decodeEntities(
    String(value ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function parseAddressText(value: string) {
  const cleaned = cleanRoundcubeCell(value);
  if (!cleaned) return [];
  const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(cleaned);
  if (match)
    return [
      {
        ...(match[1]?.trim() ? { name: match[1].trim().slice(0, 320) } : {}),
        address: match[2]!.slice(0, 320),
      },
    ];
  const email = /[^\s<>]+@[^\s<>]+/.exec(cleaned)?.[0];
  return email ? [{ address: email.slice(0, 320) }] : [];
}

function parseSogoAddresses(value: unknown) {
  if (!Array.isArray(value)) return parseAddressText(String(value ?? ""));
  return value.slice(0, 512).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const address = typeof item.email === "string" ? item.email.trim() : "";
    if (!address) return [];
    const name = typeof item.name === "string" ? item.name.trim() : "";
    return [
      {
        ...(name ? { name: name.slice(0, 320) } : {}),
        address: address.slice(0, 320),
      },
    ];
  });
}

function sogoBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
