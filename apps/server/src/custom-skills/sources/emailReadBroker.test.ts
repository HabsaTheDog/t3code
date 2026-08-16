// @effect-diagnostics globalDate:off -- The IMAP dependency returns native Date values.
import { Buffer } from "node:buffer";
import type { FetchMessageObject, FetchQueryObject, MailboxObject } from "imapflow";
import { describe, expect, it, vi } from "vite-plus/test";

import { createStudyBuddyEmailReadBroker, type ImapClientLike } from "./emailReadBroker.ts";

const mailbox = {
  path: "INBOX",
  delimiter: "/",
  flags: new Set<string>(),
  uidValidity: 734n,
  uidNext: 43,
  exists: 1,
  readOnly: true,
} as MailboxObject;

const envelope = {
  date: new Date("2026-08-14T07:00:00.000Z"),
  subject: "Lab moved to room B4",
  from: [{ name: "FH Office", address: "office@example.edu" }],
  to: [{ address: "student@example.edu" }],
};

function makeHarness(initialSeen: boolean, confirmedReadOnly = true) {
  let seen = initialSeen;
  let openedReadOnly = false;
  const fetchQueries: FetchQueryObject[] = [];
  const metadata = (): FetchMessageObject => ({
    seq: 1,
    uid: 42,
    flags: new Set(seen ? ["\\Seen"] : []),
    envelope,
    internalDate: new Date("2026-08-14T07:01:00.000Z"),
    size: 220,
    bodyStructure: { type: "text/plain" },
  });
  const client: ImapClientLike = {
    usable: true,
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    mailboxOpen: vi.fn(async (_folder, options) => {
      openedReadOnly = options.readOnly;
      return { ...mailbox, readOnly: confirmedReadOnly };
    }),
    search: vi.fn(async () => [42]),
    fetchAll: vi.fn(async () => [metadata()]),
    fetchOne: vi.fn(async (_uid, query) => {
      fetchQueries.push(query);
      if (query.source) {
        // Model ordinary IMAP BODY[] behavior: it would set Seen unless the
        // mailbox was opened read-only. The production query is source:true,
        // which ImapFlow serializes as BODY.PEEK[] as an additional safeguard.
        if (!openedReadOnly) seen = true;
        return {
          seq: 1,
          uid: 42,
          source: Buffer.from(
            "From: office@example.edu\r\nSubject: Lab moved\r\n\r\nPlease use room B4.",
          ),
        };
      }
      return metadata();
    }),
  };
  const createClient = vi.fn(() => client);
  const broker = createStudyBuddyEmailReadBroker(
    async () => ({
      transport: "imap",
      sourceId: "mail-source",
      host: "imap.example.edu",
      port: 993,
      secure: true,
      username: "student@example.edu",
      password: "app-password",
      folders: ["INBOX"],
    }),
    {
      createClient,
      parseMessage: async () => ({
        text: "Please use room B4.",
        html: '<p>Please use <strong>room B4</strong>.</p><img src="https://tracker.invalid/p">',
      }),
    },
  );
  return { broker, client, createClient, fetchQueries, getSeen: () => seen };
}

describe("Study Buddy read-only IMAP broker", () => {
  it("reads an unread message without setting Seen", async () => {
    const harness = makeHarness(false);
    const page = await harness.broker.listMessages({ sourceId: "mail-source" });
    const messageId = page.messages[0]?.messageId;
    expect(messageId).toBeTruthy();

    const result = await harness.broker.readMessage({
      sourceId: "mail-source",
      folder: "INBOX",
      messageId: messageId!,
    });

    expect(harness.client.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(harness.fetchQueries).toContainEqual({ source: true });
    expect(result.seenState).toEqual({
      seenBefore: false,
      seenAfter: false,
      preserved: true,
    });
    expect(result.message.isSeen).toBe(false);
    expect(harness.getSeen()).toBe(false);
  });

  it("preserves an already-read message's Seen state", async () => {
    const harness = makeHarness(true);
    const page = await harness.broker.listMessages({ sourceId: "mail-source" });
    const result = await harness.broker.readMessage({
      sourceId: "mail-source",
      folder: "INBOX",
      messageId: page.messages[0]!.messageId,
    });

    expect(result.seenState).toEqual({ seenBefore: true, seenAfter: true, preserved: true });
    expect(harness.getSeen()).toBe(true);
  });

  it("removes remote images and executable markup from returned HTML", async () => {
    const harness = makeHarness(false);
    const page = await harness.broker.listMessages({ sourceId: "mail-source" });
    const result = await harness.broker.readMessage({
      sourceId: "mail-source",
      folder: "INBOX",
      messageId: page.messages[0]!.messageId,
    });

    expect(result.body.sanitizedHtml).toBe("<p>Please use <strong>room B4</strong>.</p>");
    expect(result.body.sanitizedHtml).not.toContain("tracker.invalid");
  });

  it("never exposes or searches folders outside the configured source scope", async () => {
    const harness = makeHarness(false);
    await expect(
      harness.broker.listMessages({ sourceId: "mail-source", folder: "Sent" }),
    ).rejects.toThrow("outside this source's configured scope");
    expect(harness.client.connect).not.toHaveBeenCalled();
  });

  it("reads a bounded agent-context batch over one read-only connection", async () => {
    const harness = makeHarness(false);
    const results = await harness.broker.readContext({
      sourceId: "mail-source",
      query: "room",
      limit: 3,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.seenState.preserved).toBe(true);
    expect(harness.createClient).toHaveBeenCalledOnce();
    expect(harness.client.mailboxOpen).toHaveBeenCalledOnce();
    expect(harness.client.search).toHaveBeenCalledWith({ text: "room" }, { uid: true });
  });

  it("refuses message access unless the server confirms a read-only mailbox", async () => {
    const harness = makeHarness(false, false);
    await expect(harness.broker.listMessages({ sourceId: "mail-source" })).rejects.toThrow(
      "did not confirm a read-only mailbox",
    );
    expect(harness.client.fetchAll).not.toHaveBeenCalled();
  });
});
