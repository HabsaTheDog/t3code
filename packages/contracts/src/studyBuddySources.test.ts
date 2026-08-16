import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  StudyBuddyCreateSourceInput,
  StudyBuddyListEmailMessagesInput,
  StudyBuddyReadEmailMessageResult,
  StudyBuddyEmailSendApprovalPayload,
  StudyBuddyUpdateEmailPermissionsInput,
} from "./studyBuddySources.ts";

describe("Study Buddy read-only email contracts", () => {
  it("accepts adaptive email provider hints without embedding credentials", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyCreateSourceInput);
    const result = decode({
      expectedRevision: 0,
      kind: "email",
      label: "University email",
      url: "https://mail.example.edu/SOGo/",
      enabled: true,
      emailProviderHint: "sogo",
      auth: { operation: "set-password", username: "student", password: "write-only" },
    });
    expect(result.emailProviderHint).toBe("sogo");
  });
  it("accepts a message read result with explicit preserved seen state", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyReadEmailMessageResult);

    expect(
      decode({
        sourceId: "university-mail",
        message: {
          messageId: "stable-message-id",
          folder: "INBOX",
          subject: "Exam registration",
          from: [{ name: "Student Services", address: "services@example.edu" }],
          to: [{ address: "student@example.edu" }],
          receivedAt: "2026-08-14T09:30:00.000Z",
          sanitizedPreview: "Registration closes on Friday.",
          isSeen: false,
          hasAttachments: false,
        },
        cc: [],
        replyTo: [],
        body: {
          sanitizedText: "Registration closes on Friday.",
          sanitizedHtml: "<p>Registration closes on Friday.</p>",
          truncated: false,
        },
        seenState: { seenBefore: false, seenAfter: false, preserved: true },
      }).seenState,
    ).toEqual({ seenBefore: false, seenAfter: false, preserved: true });
  });

  it("rejects page sizes that could produce an unbounded mailbox read", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyListEmailMessagesInput);

    expect(() => decode({ sourceId: "university-mail", limit: 101 })).toThrow();
  });

  it("requires the adapter to report the seen state after reading", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyReadEmailMessageResult);

    expect(() =>
      decode({
        sourceId: "university-mail",
        message: {
          messageId: "stable-message-id",
          folder: "INBOX",
          subject: "Exam registration",
          from: [{ address: "services@example.edu" }],
          to: [{ address: "student@example.edu" }],
          sanitizedPreview: "Registration closes on Friday.",
          isSeen: false,
          hasAttachments: false,
        },
        cc: [],
        replyTo: [],
        body: { sanitizedText: "Registration closes on Friday.", truncated: false },
      }),
    ).toThrow();
  });

  it("accepts send only as an account permission that still requires approval", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyUpdateEmailPermissionsInput);
    expect(
      decode({
        expectedRevision: 2,
        sourceId: "university-mail",
        read: true,
        draft: true,
        send: true,
        senderEmail: "student@example.edu",
      }),
    ).toMatchObject({ send: true, senderEmail: "student@example.edu" });
  });

  it("rejects email approval header injection", () => {
    const decode = Schema.decodeUnknownSync(StudyBuddyEmailSendApprovalPayload);
    const base = {
      version: 1,
      owner: "study-buddy",
      action: "send_email",
      sourceId: "university-mail",
      from: { address: "student@example.edu" },
      to: [{ address: "office@example.edu" }],
      cc: [],
      bcc: [],
      subject: "Room question",
      bodyText: "Hello",
      attachments: [],
      expiresAt: "2026-08-15T18:00:00.000Z",
    };
    expect(() => decode({ ...base, subject: "Hello\r\nBcc: attacker@example.net" })).toThrow();
    expect(() =>
      decode({ ...base, to: [{ address: "office@example.edu\r\nBcc:bad@example.net" }] }),
    ).toThrow();
  });
});
