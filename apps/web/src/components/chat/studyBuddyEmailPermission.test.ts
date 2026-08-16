import { describe, expect, it } from "vite-plus/test";

import {
  emailPermissionOptionCopy,
  parseStudyBuddyEmailPermissionQuestion,
} from "./studyBuddyEmailPermission";

const payload = {
  version: 1,
  owner: "study-buddy",
  action: "send_email",
  sourceId: "mail-source",
  from: { address: "student@example.edu" },
  to: [{ name: "Office", address: "office@example.edu" }],
  cc: [],
  bcc: [],
  subject: "Room question",
  bodyText: "Which room should I use?",
  attachments: [],
  expiresAt: "2026-08-15T16:30:00.000Z",
} as const;

describe("Study Buddy email approval card parser", () => {
  it("accepts the exact v1 email action and preserves all displayed fields", () => {
    const parsed = parseStudyBuddyEmailPermissionQuestion({
      id: "study_buddy_email_send_v1",
      header: "Email approval",
      question: JSON.stringify(payload),
      multiSelect: false,
      options: [
        { label: "Send this email (Recommended)", description: "Send once" },
        { label: "Do not send", description: "Cancel" },
      ],
    });
    expect(parsed).toEqual(payload);
  });

  it("normalizes safe bare address strings for the dedicated approval card", () => {
    const parsed = parseStudyBuddyEmailPermissionQuestion({
      id: "study_buddy_email_send_v1",
      header: "Email approval",
      question: JSON.stringify({
        ...payload,
        from: "student@example.edu",
        to: ["office@example.edu"],
      }),
      options: [],
    });

    expect(parsed?.from).toEqual({ address: "student@example.edu" });
    expect(parsed?.to).toEqual([{ address: "office@example.edu" }]);
  });

  it("rejects a different owner, action, or question id", () => {
    for (const question of [
      { ...payload, owner: "agent" },
      { ...payload, action: "send_many" },
    ]) {
      expect(
        parseStudyBuddyEmailPermissionQuestion({
          id: "study_buddy_email_send_v1",
          header: "Email approval",
          question: JSON.stringify(question),
          options: [],
        }),
      ).toBeNull();
    }
    expect(
      parseStudyBuddyEmailPermissionQuestion({
        id: "ordinary_question",
        header: "Email approval",
        question: JSON.stringify(payload),
        options: [],
      }),
    ).toBeNull();
  });

  it("rejects header injection and invalid recipients", () => {
    for (const question of [
      { ...payload, subject: "Room question\r\nBcc: attacker@example.com" },
      { ...payload, to: [{ address: "not-an-email" }] },
      { ...payload, from: { name: "Student\nBcc", address: "student@example.edu" } },
    ]) {
      expect(
        parseStudyBuddyEmailPermissionQuestion({
          id: "study_buddy_email_send_v1",
          header: "Email approval",
          question: JSON.stringify(question),
          options: [],
        }),
      ).toBeNull();
    }
  });

  it("uses plain approval copy", () => {
    expect(emailPermissionOptionCopy("Send this email (Recommended)", "raw")).toMatchObject({
      label: "Send this email",
      intent: "approve",
    });
    expect(emailPermissionOptionCopy("Do not send", "raw")).toMatchObject({
      label: "Do not send",
      intent: "decline",
    });
  });
});
