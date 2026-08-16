// @effect-diagnostics globalDate:off -- Tests use a bounded wall-clock expiry fixture.
import type { StudyBuddyEmailSendApprovalPayload, UserInputQuestion } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  captureStudyBuddyEmailApprovalActivity,
  captureStudyBuddyEmailApprovalRequest,
  clearStudyBuddyEmailApprovalRequestsForTest,
  type EmailApprovalExecution,
  registerStudyBuddyEmailApprovalExecutor,
  resolveStudyBuddyEmailApprovalResponse,
} from "./emailSendApprovals.ts";

afterEach(() => {
  clearStudyBuddyEmailApprovalRequestsForTest();
  vi.useRealTimers();
});

function payload(): StudyBuddyEmailSendApprovalPayload {
  return {
    version: 1,
    owner: "study-buddy",
    action: "send_email",
    sourceId: "source-mail",
    from: { address: "student@example.edu" },
    to: [{ name: "Study Office", address: "office@example.edu" }],
    cc: [],
    bcc: [],
    subject: "Question about the lab",
    bodyText: "Hello,\n\nCould you confirm the room?\n\nThank you",
    attachments: [],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function question(message = payload()): UserInputQuestion {
  return {
    id: "study_buddy_email_send_v1",
    header: "Email approval",
    question: JSON.stringify(message),
    multiSelect: false,
    options: [
      { label: "Send this email (Recommended)", description: "Send this exact email once." },
      { label: "Do not send", description: "Nothing will be sent." },
    ],
  };
}

describe("Study Buddy exact-email approval broker", () => {
  it("executes the frozen email once after the native approval answer", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-1", [question()]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-1", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: true, sent: true });
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]?.[0].payload).toMatchObject({
      sourceId: "source-mail",
      to: [{ address: "office@example.edu" }],
      subject: "Question about the lab",
    });
    expect(executor.mock.calls[0]?.[0].threadId).toBe("thread-1");

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-1", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: false, sent: false });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rebuilds the exact approval from the request persisted for the chat UI", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalActivity("thread-1", "request-persisted", {
      requestId: "request-persisted",
      questions: [question()],
    });

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-persisted", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: true, sent: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("server-clamps an overly long provider expiry and still executes the visible approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T13:00:00.000Z"));
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    const providerPayload = {
      ...payload(),
      expiresAt: "2026-08-16T21:00:00.000Z",
    };
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-long-expiry", [
      question(providerPayload),
    ]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-long-expiry", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: true, sent: true });
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]?.[0].payload.expiresAt).toBe(providerPayload.expiresAt);

    captureStudyBuddyEmailApprovalRequest("thread-1", "request-clamped-expiry", [
      question(providerPayload),
    ]);
    vi.advanceTimersByTime(31 * 60_000);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-clamped-expiry", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).rejects.toThrow("approval expired");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("normalizes safe bare address strings produced by a provider", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-strings", [
      question({
        ...payload(),
        from: "student@example.edu",
        to: ["student@example.edu"],
      } as unknown as StudyBuddyEmailSendApprovalPayload),
    ]);

    await resolveStudyBuddyEmailApprovalResponse("thread-1", "request-strings", {
      study_buddy_email_send_v1: "Send this email (Recommended)",
    });

    expect(executor.mock.calls[0]?.[0].payload).toMatchObject({
      from: { address: "student@example.edu" },
      to: [{ address: "student@example.edu" }],
    });
  });

  it("consumes a decline without executing anything", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-2", [question()]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-2", {
        study_buddy_email_send_v1: "Do not send",
      }),
    ).resolves.toEqual({ handled: true, sent: false });
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when an answer contains more than one choice", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-ambiguous", [question()]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-ambiguous", {
        study_buddy_email_send_v1: ["Send this email (Recommended)", "Do not send"],
      }),
    ).resolves.toEqual({ handled: true, sent: false });
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps identical provider request ids isolated between chat threads", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-a", "request-1", [question()]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-b", "request-1", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: false, sent: false });
    expect(executor).not.toHaveBeenCalled();

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-a", "request-1", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: true, sent: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rejects expired, malformed, multi-select, and attachment-bearing requests", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    const expired = { ...payload(), expiresAt: new Date(Date.now() - 1_000).toISOString() };
    const withAttachment = {
      ...payload(),
      attachments: [{ id: "file-1", name: "notes.pdf", sizeBytes: 10, sha256: "a".repeat(64) }],
    };
    captureStudyBuddyEmailApprovalRequest("thread-1", "expired", [question(expired)]);
    captureStudyBuddyEmailApprovalRequest("thread-1", "attachment", [question(withAttachment)]);
    captureStudyBuddyEmailApprovalRequest("thread-1", "multi", [
      { ...question(), multiSelect: true },
    ]);

    for (const requestId of ["expired", "attachment", "multi"]) {
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", requestId, {
          study_buddy_email_send_v1: "Send this email (Recommended)",
        }),
      ).resolves.toEqual({ handled: false, sent: false });
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when delivery is unavailable and never makes the approval reusable", async () => {
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-3", [question()]);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-3", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).rejects.toThrow("sending is unavailable");
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-3", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({ handled: false, sent: false });
  });
});
