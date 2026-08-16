import type { StudyBuddyEmailSendApprovalPayload } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createRoundcubeWebmailProfile, createSogoWebmailProfile } from "./webmailProfiles.ts";

const message: StudyBuddyEmailSendApprovalPayload = {
  version: 1,
  owner: "study-buddy",
  action: "send_email",
  sourceId: "mail-source",
  from: { name: "Student", address: "student@example.edu" },
  to: [{ name: "Office", address: "office@example.edu" }],
  cc: [{ address: "tutor@example.edu" }],
  bcc: [],
  subject: "Room question",
  bodyText: "Hello,\n\nWhich room should I use?",
  attachments: [],
  expiresAt: "2026-08-15T18:00:00.000Z",
};

const access = {
  transport: "webmail" as const,
  sourceId: "mail-source",
  profileId: "sogo",
  baseUrl: "https://mail.example.edu/SOGo/",
  username: "student",
  password: "secret",
  senderEmail: "student@example.edu",
  folders: ["INBOX"],
};

describe("webmail exact-send profiles", () => {
  it("sends the approved fields through SOGo's compose draft endpoint", async () => {
    let sentBody: Record<string, unknown> | undefined;
    let sent = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/connect")) {
        return json({ username: "student" }, { headers: { "set-cookie": "sid=fake; Path=/" } });
      }
      if (url.endsWith("/so/student/Mail/0/compose")) {
        return json({ accountId: "0", mailboxPath: "Drafts", draftId: "draft-1" }, { status: 201 });
      }
      if (url.endsWith("/so/student/Mail/0/view")) {
        return json({ mailboxes: [{ path: "Sent", type: "sent", children: [] }] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/view")) {
        return json({ uids: sent ? ["11", "10"] : ["10"] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/headers")) {
        const requested = JSON.parse(String(init?.body)) as { uids?: string[] };
        if (!requested.uids?.includes("11")) {
          return json([
            ["uid", "Subject", "From", "To", "isRead", "hasAttachment"],
            ["10", "Older email", [{ email: "other@example.edu" }], [], 1, 0],
          ]);
        }
        return json([
          ["uid", "Subject", "From", "To", "isRead", "hasAttachment"],
          [
            "11",
            "Room question",
            [{ name: "Student", email: "student@example.edu" }],
            [{ name: "Office", email: "office@example.edu" }, { email: "tutor@example.edu" }],
            1,
            0,
          ],
        ]);
      }
      if (url.endsWith("/so/student/Mail/0/folderDrafts/draft-1/edit")) {
        return json({ from: "Student <student@example.edu>", to: [], cc: [], bcc: [] });
      }
      if (url.endsWith("/so/student/Mail/0/folderDrafts/draft-1/send")) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent = true;
        return json({ status: "success" });
      }
      return new Response("missing", { status: 404 });
    });
    const profile = createSogoWebmailProfile({
      fetch: fetch as unknown as typeof globalThis.fetch,
      validateUrl: async () => undefined,
      wait: async () => undefined,
    });
    const session = await profile.login(access);
    await profile.sendExact!(session, message);

    expect(sentBody).toMatchObject({
      from: "Student <student@example.edu>",
      to: ["Office <office@example.edu>"],
      cc: ["tutor@example.edu"],
      subject: "Room question",
      text: "Hello,\n\nWhich room should I use?",
      isHTML: false,
    });
  });

  it("does not send a second SOGo copy when the exact email was delivered recently", async () => {
    let sendCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/connect")) return json({ username: "student" });
      if (url.endsWith("/so/student/Mail/0/view")) {
        return json({ mailboxes: [{ path: "Sent", type: "sent", children: [] }] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/view")) return json({ uids: ["10"] });
      if (url.endsWith("/so/student/Mail/0/folderSent/headers")) {
        return json([
          ["uid", "Subject", "From", "To", "isRead", "hasAttachment"],
          [
            "10",
            "Room question",
            [{ name: "Student", email: "student@example.edu" }],
            [{ name: "Office", email: "office@example.edu" }, { email: "tutor@example.edu" }],
            1,
            0,
          ],
        ]);
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/10/export")) {
        return new Response(
          "Date: Sat, 15 Aug 2026 17:55:00 +0000\r\n" +
            "From: Student <student@example.edu>\r\n" +
            "To: Office <office@example.edu>, tutor@example.edu\r\n" +
            "Subject: Room question\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
            "Hello,\r\n\r\nWhich room should I use?\r\n",
        );
      }
      if (url.endsWith("/send")) {
        sendCalls += 1;
        return json({ status: "success" });
      }
      return new Response("missing", { status: 404 });
    });
    const profile = createSogoWebmailProfile({
      fetch: fetch as unknown as typeof globalThis.fetch,
      validateUrl: async () => undefined,
      now: () => Date.parse("2026-08-15T18:00:00.000Z"),
    });
    const session = await profile.login(access);

    await expect(profile.sendExact!(session, message)).resolves.toBeUndefined();
    expect(sendCalls).toBe(0);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/compose"))).toBe(false);
  });

  it("rejects SOGo success when no matching email appears in Sent", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/connect")) return json({ username: "student" });
      if (url.endsWith("/so/student/Mail/0/view")) {
        return json({ mailboxes: [{ path: "Sent", type: "sent", children: [] }] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/view")) {
        return json({ uids: ["10"] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/headers")) return json([]);
      if (url.endsWith("/compose")) {
        return json({ accountId: "0", mailboxPath: "Drafts", draftId: "draft-1" });
      }
      if (url.endsWith("/edit")) return json({ from: "Student <student@example.edu>" });
      if (url.endsWith("/send")) return json({ status: "success" });
      return new Response("missing", { status: 404 });
    });
    const profile = createSogoWebmailProfile({
      fetch: fetch as unknown as typeof globalThis.fetch,
      validateUrl: async () => undefined,
      wait: async () => undefined,
    });
    const session = await profile.login(access);

    await expect(profile.sendExact!(session, message)).rejects.toThrow("did not appear in Sent");
  });

  it("sends the approved fields through Roundcube's normal compose form", async () => {
    let sentBody: URLSearchParams | undefined;
    let loginCompleted = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("_action=")) {
        if (init?.method === "POST") {
          loginCompleted = true;
          return html('<input name="_token" value="token-2"><main>Inbox</main>');
        }
        return html('<input name="_token" value="token-1"><input name="_pass">');
      }
      if (url.includes("_action=compose")) {
        expect(loginCompleted).toBe(true);
        return html(`
          <input name="_id" value="compose-1">
          <input name="_token" value="token-3">
          <select name="_from">
            <option value="17" selected>Student &lt;student@example.edu&gt;</option>
          </select>
        `);
      }
      if (url.includes("_action=send")) {
        sentBody = init?.body as URLSearchParams;
        return html('parent.rcmail.display_message("messagesent", "confirmation");');
      }
      return new Response("missing", { status: 404 });
    });
    const profile = createRoundcubeWebmailProfile({
      fetch: fetch as unknown as typeof globalThis.fetch,
      validateUrl: async () => undefined,
    });
    const session = await profile.login({ ...access, profileId: "roundcube" });
    await profile.sendExact!(session, message);

    expect(sentBody?.get("_id")).toBe("compose-1");
    expect(sentBody?.get("_from")).toBe("17");
    expect(sentBody?.get("_to")).toBe("Office <office@example.edu>");
    expect(sentBody?.get("_cc")).toBe("tutor@example.edu");
    expect(sentBody?.get("_subject")).toBe("Room question");
    expect(sentBody?.get("_message")).toBe("Hello,\n\nWhich room should I use?");
  });

  it("refuses a sender that differs from the connected provider identity", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/connect")) return json({ username: "student" });
      if (url.endsWith("/so/student/Mail/0/view")) {
        return json({ mailboxes: [{ path: "Sent", type: "sent", children: [] }] });
      }
      if (url.endsWith("/so/student/Mail/0/folderSent/view")) return json({ uids: [] });
      if (url.endsWith("/compose")) {
        return json({ accountId: "0", mailboxPath: "Drafts", draftId: "draft-1" });
      }
      if (url.endsWith("/edit")) return json({ from: "Other <other@example.edu>" });
      return json({ status: "success" });
    });
    const profile = createSogoWebmailProfile({
      fetch: fetch as unknown as typeof globalThis.fetch,
      validateUrl: async () => undefined,
      wait: async () => undefined,
    });
    const session = await profile.login(access);
    await expect(profile.sendExact!(session, message)).rejects.toThrow("sender does not match");
  });
});

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function html(value: string) {
  return new Response(value, { status: 200, headers: { "content-type": "text/html" } });
}
