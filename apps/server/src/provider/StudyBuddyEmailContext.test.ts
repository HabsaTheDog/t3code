import { afterEach, describe, expect, it, vi } from "vitest";

import {
  augmentPromptWithStudyBuddyEmailContext,
  registerStudyBuddyEmailContextReader,
} from "./StudyBuddyEmailContext.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

const account = {
  sourceId: "personal-mail",
  sourceLabel: "Personal mail",
  senderEmail: "student@example.edu",
  canRead: true,
  canDraft: true,
  canRequestSend: false,
};

function payload(context: string) {
  const match = context.match(/\n(\{"accounts":.*\})\n<\/study_buddy_email_context>$/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("Study Buddy account-policy bridge", () => {
  it("preserves the original prompt when no server reader is installed", async () => {
    await expect(augmentPromptWithStudyBuddyEmailContext("Check my email")).resolves.toBe(
      "Check my email",
    );
  });

  it.each([
    "Kannst du mal durchschauen, was bei meinen E Mails noch alles so offen ist oder was da noch ansteht?",
    "Was ist bei meinen E-Mails noch offen?",
    "Welche Antworten und Fristen stehen in meinem Postfach an?",
    "Anything in my inbox I still need to do?",
    "can you check if i have any important eamils in the last month?",
    "Schreib eine Entschuldigung an meinen Professor wegen Zugverspätung.",
    "Find my professor's email address, but do not read my emails.",
    "Lies meine Mails nicht; erklär mir diese Formel.",
    "Explain this formula",
  ])("makes account policy available without reading bodies or classifying: %s", async (prompt) => {
    const reader = vi.fn(async () => ({ accounts: [account] }));
    dispose = registerStudyBuddyEmailContextReader(reader);

    const result = await augmentPromptWithStudyBuddyEmailContext(prompt);
    expect(result.startsWith(`${prompt}\n\n`)).toBe(true);
    expect(reader.mock.calls).toEqual([[]]);
    expect(payload(result)).toEqual({ accounts: [account], accountsTruncated: false });
    expect(result).toContain("not mailbox messages");
    expect(result).toContain("metadata availability alone proves neither authentication");
  });

  it("whitelists account fields and drops accidentally supplied message or credential fields", async () => {
    dispose = registerStudyBuddyEmailContextReader(async () => ({
      accounts: [{ ...account, password: "secret-password", bodyText: "private-body" }],
      messages: [{ bodyText: "private-message" }],
      cookie: "private-cookie",
    }));
    const result = await augmentPromptWithStudyBuddyEmailContext("Read my emails");
    expect(result).not.toContain("secret-password");
    expect(result).not.toContain("private-body");
    expect(result).not.toContain("private-message");
    expect(result).not.toContain("private-cookie");
    expect(payload(result).accounts).toEqual([account]);
  });

  it("bounds account metadata as complete JSON, exposing omitted accounts", async () => {
    dispose = registerStudyBuddyEmailContextReader(async () => ({
      accounts: Array.from({ length: 100 }, (_, index) => ({
        ...account,
        sourceId: `account-${index}`,
        sourceLabel: '\n"'.repeat(1000),
        senderEmail: "s".repeat(1000),
      })),
    }));
    const result = await augmentPromptWithStudyBuddyEmailContext("Any mail tasks?");
    const data = payload(result);
    expect(data.accounts.length).toBeGreaterThan(0);
    expect(data.accounts.length).toBeLessThanOrEqual(32);
    expect(data.accountsTruncated).toBe(true);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(24_000);
    expect(data.accounts.every((item: typeof account) => item.sourceLabel.length <= 320)).toBe(
      true,
    );
  });

  it("sanitizes control characters and fails closed on non-boolean permissions", async () => {
    dispose = registerStudyBuddyEmailContextReader(async () => ({
      accounts: [
        {
          ...account,
          sourceLabel: "Mail\u0000\u0008 account",
          canRead: "allowed" as unknown as boolean,
        },
      ],
    }));
    const data = payload(await augmentPromptWithStudyBuddyEmailContext("Check my inbox"));
    expect(data.accounts[0].sourceLabel).toBe("Mail account");
    expect(data.accounts[0].canRead).toBe(false);
  });

  it("distinguishes no enabled account from unavailable account metadata", async () => {
    dispose = registerStudyBuddyEmailContextReader(async () => ({ accounts: [] }));
    expect(await augmentPromptWithStudyBuddyEmailContext("Check my inbox")).toContain(
      'status="no-accounts"',
    );
    dispose();
    dispose = registerStudyBuddyEmailContextReader(async () => {
      throw new Error("private-token/private-transport-error");
    });
    const result = await augmentPromptWithStudyBuddyEmailContext("Check my inbox");
    expect(result).toContain('status="unavailable"');
    expect(result).toContain("do not infer that no account is configured");
    expect(result).not.toContain("private-token");
  });

  it("keeps exact-message native approval with object-valued addresses", async () => {
    dispose = registerStudyBuddyEmailContextReader(async () => ({ accounts: [account] }));
    const result = await augmentPromptWithStudyBuddyEmailContext("Send an email");
    expect(result).toContain("study_buddy_email_send_v1");
    expect(result).toContain("expiresAt no more than 30 minutes away");
    expect(result).toContain('from={"address":"student@example.edu"}');
    expect(result).toContain('to=[{"address":"recipient@example.edu"}]');
    expect(result).toContain("Send this email (Recommended) and Do not send");
    expect(result).toContain("never perform a separate mailbox or transport send yourself");
    expect(result).toContain("Ordinary chat approval is never enough");
  });

  it("does not let disposal of an old registration remove a newer reader", async () => {
    const oldDispose = registerStudyBuddyEmailContextReader(async () => ({ accounts: [] }));
    dispose = registerStudyBuddyEmailContextReader(async () => ({ accounts: [account] }));
    oldDispose();
    expect(payload(await augmentPromptWithStudyBuddyEmailContext("hello")).accounts).toEqual([
      account,
    ]);
  });
});
