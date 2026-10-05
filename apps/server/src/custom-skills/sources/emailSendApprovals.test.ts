// @effect-diagnostics globalDate:off -- Tests use a bounded wall-clock expiry fixture.
import type { StudyBuddyEmailSendApprovalPayload, UserInputQuestion } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeAntigravityUserInputResponse } from "../../provider/acp/AntigravityProtocol.ts";

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
  it("binds a provider-owned question id to the exact message and native answer key", async () => {
    const proposal = question();
    const native = { ...proposal, id: proposal.question };
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "native-question", [native]);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "native-question", {
        [native.id]: "Send this email (Recommended)",
      }),
    ).resolves.toMatchObject({ handled: true, sent: true, questionId: native.id });
    expect(executor).toHaveBeenCalledOnce();
  });

  it.each(["changed-id", "malformed", "extra-question", "expired"] as const)(
    "invalidates the original proposal after a %s replacement",
    async (replacement) => {
      const original = question();
      const candidate = { ...question() };
      candidate.id = replacement === "changed-id" ? "provider-question" : original.id;
      if (replacement === "malformed") candidate.question = "{broken";
      if (replacement === "expired")
        candidate.question = JSON.stringify({
          ...payload(),
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
      const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
      registerStudyBuddyEmailApprovalExecutor(executor);
      captureStudyBuddyEmailApprovalRequest("thread-1", "replacement", [original]);
      captureStudyBuddyEmailApprovalRequest(
        "thread-1",
        "replacement",
        replacement === "extra-question"
          ? [candidate, { ...question(), id: "second" }]
          : [candidate],
      );
      captureStudyBuddyEmailApprovalRequest("thread-1", "replacement", [original]);
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", "replacement", {
          [original.id]: "Send this email (Recommended)",
        }),
      ).rejects.toThrow();
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("returns the provider question id on uncertain delivery failures", async () => {
    const native = { ...question(), id: "claude-question-text" };
    registerStudyBuddyEmailApprovalExecutor(async () => {
      throw new Error("Delivery uncertain");
    });
    captureStudyBuddyEmailApprovalRequest("thread-1", "uncertain-native", [native]);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "uncertain-native", {
        [native.id]: "Send this email (Recommended)",
      }),
    ).rejects.toMatchObject({ questionId: native.id, message: "Delivery uncertain" });
  });

  it.each(["owner", "action", "version", "labels", "multi", "additional"] as const)(
    "does not authorize a noncanonical %s card",
    async (fault) => {
      const candidate = { ...question(), id: "native-id" };
      if (["owner", "action", "version"].includes(fault))
        candidate.question = JSON.stringify({ ...payload(), [fault]: "invalid" });
      if (fault === "labels")
        candidate.options = [
          { label: "Send", description: "Send" },
          { label: "Cancel", description: "Cancel" },
        ];
      if (fault === "multi") candidate.multiSelect = true;
      const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
      registerStudyBuddyEmailApprovalExecutor(executor);
      captureStudyBuddyEmailApprovalRequest(
        "thread-1",
        "invalid-native",
        fault === "additional" ? [candidate, { ...question(), id: "second" }] : [candidate],
      );
      const result = resolveStudyBuddyEmailApprovalResponse("thread-1", "invalid-native", {
        "native-id": "Send this email (Recommended)",
      });
      if (["owner", "action", "version"].includes(fault))
        await expect(result).resolves.toEqual({ handled: false, sent: false });
      else await expect(result).rejects.toMatchObject({ questionId: "native-id" });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("uses only the captured native answer key and consumes a missing approval", async () => {
    const candidate = { ...question(), id: "native-id" };
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "wrong-answer", [candidate]);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "wrong-answer", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({
      handled: true,
      sent: false,
      questionId: "native-id",
      answer: "Do not send",
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["approved", "declined", "error"] as const)(
    "binds opaque ACP choice tokens for a %s outcome",
    async (outcome) => {
      const candidate = {
        ...question(),
        id: "interaction_mock-question",
        options: [
          {
            label: "Send this email (Recommended)",
            value: "approve-wire-id",
            description: "Send once",
          },
          { label: "Do not send", value: "deny-wire-id", description: "Decline" },
        ],
      };
      const executor = vi.fn(async () => {
        if (outcome === "error") throw new Error("Uncertain delivery");
      });
      registerStudyBuddyEmailApprovalExecutor(executor);
      captureStudyBuddyEmailApprovalRequest("thread-1", "opaque", [candidate]);
      const response = resolveStudyBuddyEmailApprovalResponse("thread-1", "opaque", {
        [candidate.id]: outcome === "declined" ? "deny-wire-id" : "approve-wire-id",
      });
      if (outcome !== "error") {
        const result = await response;
        expect(
          makeAntigravityUserInputResponse(
            {
              sessionId: "session-1",
              toolCall: {
                toolCallId: candidate.id,
                status: "pending",
                title: candidate.question,
                rawInput: {},
              },
              options: candidate.options.map((option) => ({
                optionId: option.value,
                name: option.label,
                kind: "allow_once" as const,
              })),
            },
            { [candidate.id]: result.answer ?? "" },
          ),
        ).toEqual({
          outcome: {
            outcome: "selected",
            optionId: outcome === "approved" ? "approve-wire-id" : "deny-wire-id",
          },
        });
      }
      if (outcome === "error")
        await expect(response).rejects.toMatchObject({
          answers: { [candidate.id]: "deny-wire-id" },
        });
      else
        await expect(response).resolves.toMatchObject({
          sent: outcome === "approved",
          questionId: candidate.id,
          answer: outcome === "approved" ? "approve-wire-id" : "deny-wire-id",
        });
      expect(executor).toHaveBeenCalledTimes(outcome === "declined" ? 0 : 1);
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", "opaque", {
          [candidate.id]: "approve-wire-id",
        }),
      ).rejects.toMatchObject({ answers: { [candidate.id]: "deny-wire-id" } });
    },
  );

  it.each(["swapped", "duplicate", "empty"] as const)(
    "rejects a %s opaque token mapping",
    async (fault) => {
      const original = {
        ...question(),
        id: "native-id",
        options: [
          { label: "Send this email (Recommended)", value: "approve-wire", description: "Send" },
          { label: "Do not send", value: "deny-wire", description: "Decline" },
        ],
      };
      const executor = vi.fn(async () => undefined);
      registerStudyBuddyEmailApprovalExecutor(executor);
      captureStudyBuddyEmailApprovalRequest("thread-1", "token-change", [original]);
      captureStudyBuddyEmailApprovalRequest("thread-1", "token-change", [
        {
          ...original,
          options: original.options.map((option, index) => ({
            ...option,
            value:
              fault === "swapped"
                ? index === 0
                  ? "deny-wire"
                  : "approve-wire"
                : fault === "duplicate"
                  ? "same"
                  : "",
          })),
        },
      ]);
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", "token-change", {
          "native-id": "approve-wire",
        }),
      ).rejects.toThrow();
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("denies an intended persisted card even if its question schema is malformed", async () => {
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      "invalid-persisted",
      {
        requestId: "invalid-persisted",
        questions: [{ id: "native-id", question: JSON.stringify(payload()), options: "broken" }],
      },
      new Date().toISOString(),
    );
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "invalid-persisted", {
        "native-id": "Send this email (Recommended)",
      }),
    ).rejects.toMatchObject({ questionId: "native-id", answers: { "native-id": "Do not send" } });
  });

  it("executes the frozen email once after the native approval answer", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-1", [question()]);

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-1", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });
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
    ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rebuilds the exact approval from the request persisted for the chat UI", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      "request-persisted",
      {
        requestId: "request-persisted",
        questions: [question()],
      },
      new Date(Date.now()).toISOString(),
    );

    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-persisted", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });
    expect(executor).toHaveBeenCalledOnce();
  });

  it.each(["approved", "declined", "delivery-uncertain"] as const)(
    "does not revive a %s approval when the reactor recaptures its persisted activity",
    async (outcome) => {
      const executor = vi.fn(async (_request: EmailApprovalExecution) => {
        if (outcome === "delivery-uncertain") throw new Error("Delivery status unknown");
      });
      registerStudyBuddyEmailApprovalExecutor(executor);
      const activity = {
        createdAt: new Date(Date.now()).toISOString(),
        requestId: "request-replayed",
        questions: [question()],
      };
      const approve = { study_buddy_email_send_v1: "Send this email (Recommended)" };
      captureStudyBuddyEmailApprovalActivity(
        "thread-1",
        activity.requestId,
        activity,
        activity.createdAt,
      );

      const first = resolveStudyBuddyEmailApprovalResponse(
        "thread-1",
        activity.requestId,
        outcome === "declined" ? { study_buddy_email_send_v1: "Do not send" } : approve,
      );
      if (outcome === "delivery-uncertain")
        await expect(first).rejects.toThrow("Delivery status unknown");
      else
        await expect(first).resolves.toEqual({
          handled: true,
          sent: outcome === "approved",
          answer: outcome === "approved" ? "Send this email (Recommended)" : "Do not send",
          questionId: "study_buddy_email_send_v1",
        });

      // The actual reactor reconstructs the same stored request before every response.
      captureStudyBuddyEmailApprovalActivity(
        "thread-1",
        activity.requestId,
        activity,
        activity.createdAt,
      );
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve),
      ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
      expect(executor).toHaveBeenCalledTimes(outcome === "declined" ? 0 : 1);
    },
  );

  it("consumes before delivery so an in-flight persisted request cannot execute twice", async () => {
    const deliveries: Array<() => void> = [];
    const executor = vi.fn(async (_request: EmailApprovalExecution) => {
      await new Promise<void>((resolve) => {
        deliveries.push(resolve);
      });
    });
    registerStudyBuddyEmailApprovalExecutor(executor);
    const activity = {
      createdAt: new Date(Date.now()).toISOString(),
      requestId: "request-in-flight",
      questions: [question()],
    };
    const approve = { study_buddy_email_send_v1: "Send this email (Recommended)" };
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      activity.createdAt,
    );
    const delivery = resolveStudyBuddyEmailApprovalResponse(
      "thread-1",
      activity.requestId,
      approve,
    );
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      activity.createdAt,
    );
    const replay = resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve);
    await expect(replay).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
    deliveries.forEach((finishDelivery) => finishDelivery());
    await expect(delivery).resolves.toEqual({
      handled: true,
      sent: true,
      answer: "Send this email (Recommended)",
      questionId: "study_buddy_email_send_v1",
    });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("does not renew the broker's expiry when an old persisted card is reconstructed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T13:00:00.000Z"));
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    clearStudyBuddyEmailApprovalRequestsForTest();
    registerStudyBuddyEmailApprovalExecutor(executor);
    const activity = {
      createdAt: new Date(Date.now()).toISOString(),
      requestId: "request-recaptured-expiry",
      questions: [question({ ...payload(), expiresAt: "2026-08-16T21:00:00.000Z" })],
    };
    const approve = { study_buddy_email_send_v1: "Send this email (Recommended)" };
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      activity.createdAt,
    );
    vi.advanceTimersByTime(31 * 60_000);
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      activity.createdAt,
    );
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve),
    ).rejects.toThrow("approval expired");
    captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      activity.createdAt,
    );
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve),
    ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("requires a new request identity after conflicting proposal content invalidates a card", async () => {
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    const original = question();
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-conflict", [original]);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-conflict", [
      question({ ...payload(), to: [{ address: "different@example.edu" }] }),
    ]);
    captureStudyBuddyEmailApprovalRequest("thread-1", "request-conflict", [original]);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", "request-conflict", {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid", "previous-session", "future"] as const)(
    "fails closed when persisted approval timing is %s",
    async (timing) => {
      const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
      registerStudyBuddyEmailApprovalExecutor(executor);
      const activity = { requestId: "request-unverifiable", questions: [question()] };
      const createdAt =
        timing === "missing"
          ? undefined
          : timing === "invalid"
            ? "not-a-timestamp"
            : new Date(Date.now() + (timing === "future" ? 60_000 : -3_600_000)).toISOString();
      expect(() =>
        captureStudyBuddyEmailApprovalActivity("thread-1", activity.requestId, activity, createdAt),
      ).toThrow("prepare a fresh approval");
      await expect(
        resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, {
          study_buddy_email_send_v1: "Send this email (Recommended)",
        }),
      ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it("uses the first persisted request timestamp when reconstruction itself is delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T13:00:00.000Z"));
    clearStudyBuddyEmailApprovalRequestsForTest();
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    registerStudyBuddyEmailApprovalExecutor(executor);
    const createdAt = new Date(Date.now()).toISOString();
    const activity = {
      requestId: "request-delayed-reconstruction",
      questions: [question({ ...payload(), expiresAt: "2026-08-16T21:00:00.000Z" })],
    };
    vi.advanceTimersByTime(29 * 60_000);
    captureStudyBuddyEmailApprovalActivity("thread-1", activity.requestId, activity, createdAt);
    vi.advanceTimersByTime(2 * 60_000);
    await expect(
      resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, {
        study_buddy_email_send_v1: "Send this email (Recommended)",
      }),
    ).rejects.toThrow("approval expired");
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not reconstruct an earlier session's consumed card after a broker restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T13:00:00.000Z"));
    vi.resetModules();
    const initial = await import("./emailSendApprovals.ts");
    const executor = vi.fn(async (_request: EmailApprovalExecution) => undefined);
    initial.registerStudyBuddyEmailApprovalExecutor(executor);
    const createdAt = new Date(Date.now()).toISOString();
    const activity = { requestId: "request-before-restart", questions: [question()] };
    const approve = { study_buddy_email_send_v1: "Send this email (Recommended)" };
    initial.captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      activity.requestId,
      activity,
      createdAt,
    );
    await expect(
      initial.resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve),
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });

    vi.advanceTimersByTime(60_000);
    vi.resetModules();
    const restarted = await import("./emailSendApprovals.ts");
    restarted.registerStudyBuddyEmailApprovalExecutor(executor);
    expect(() =>
      restarted.captureStudyBuddyEmailApprovalActivity(
        "thread-1",
        activity.requestId,
        activity,
        createdAt,
      ),
    ).toThrow("earlier or unverifiable app session");
    await expect(
      restarted.resolveStudyBuddyEmailApprovalResponse("thread-1", activity.requestId, approve),
    ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
    expect(executor).toHaveBeenCalledOnce();

    // The user can still approve a genuinely new card in the new app session.
    const fresh = { requestId: "request-after-restart", questions: [question()] };
    restarted.captureStudyBuddyEmailApprovalActivity(
      "thread-1",
      fresh.requestId,
      fresh,
      new Date(Date.now()).toISOString(),
    );
    await expect(
      restarted.resolveStudyBuddyEmailApprovalResponse("thread-1", fresh.requestId, approve),
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });
    expect(executor).toHaveBeenCalledTimes(2);
    restarted.clearStudyBuddyEmailApprovalRequestsForTest();
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
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });
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
    ).resolves.toEqual({
      handled: true,
      sent: false,
      questionId: "study_buddy_email_send_v1",
      answer: "Do not send",
    });
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
    ).resolves.toEqual({
      handled: true,
      sent: false,
      questionId: "study_buddy_email_send_v1",
      answer: "Do not send",
    });
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
    ).resolves.toEqual({
      handled: true,
      sent: true,
      questionId: "study_buddy_email_send_v1",
      answer: "Send this email (Recommended)",
    });
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
      ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
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
    ).rejects.toMatchObject({ questionId: "study_buddy_email_send_v1" });
  });
});
