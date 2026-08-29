// @effect-diagnostics globalDate:off -- Tests use bounded wall-clock expiry fixtures.
import type { UserInputQuestion } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertStudyBuddyQuizApprovalGrant,
  captureStudyBuddyQuizApprovalActivity,
  captureStudyBuddyQuizApprovalRequest,
  clearStudyBuddyQuizApprovalsForTest,
  resolveStudyBuddyQuizApprovalResponse,
} from "./quizApprovals.ts";

afterEach(clearStudyBuddyQuizApprovalsForTest);

function payload() {
  return {
    version: 1,
    owner: "study-buddy",
    action: "execute_quiz_attempt",
    scope: "exact_quiz_attempt",
    status: "pending",
    requestId: "quiz-request-1",
    targetUrl: "https://moodle.example.test/mod/quiz/view.php?id=7",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    quizTitle: "Dynamics",
  } as const;
}

function question(message = payload()): UserInputQuestion {
  return {
    id: "study_buddy_quiz_permission_v1",
    header: "Quiz access",
    question: JSON.stringify(message),
    multiSelect: false,
    options: [
      { label: "Work on quiz (Recommended)", description: "Approve this exact quiz scope." },
      { label: "Do not allow", description: "Do not open or change the attempt." },
    ],
  };
}

describe("Study Buddy native quiz approval broker", () => {
  it("rejects a fabricated grant until the native response approves the exact payload", () => {
    const request = payload();
    expect(() => assertStudyBuddyQuizApprovalGrant(request)).toThrow("was not approved");
    captureStudyBuddyQuizApprovalRequest("thread-1", "native-request-1", [question(request)]);
    expect(() => assertStudyBuddyQuizApprovalGrant(request)).toThrow("was not approved");

    expect(
      resolveStudyBuddyQuizApprovalResponse("thread-1", "native-request-1", {
        study_buddy_quiz_permission_v1: "Work on quiz (Recommended)",
      }),
    ).toEqual({ handled: true, approved: true });
    expect(() => assertStudyBuddyQuizApprovalGrant(request)).not.toThrow();
  });

  it("fails closed after decline and when the payload changes", () => {
    captureStudyBuddyQuizApprovalRequest("thread-1", "native-request-1", [question()]);
    expect(
      resolveStudyBuddyQuizApprovalResponse("thread-1", "native-request-1", {
        study_buddy_quiz_permission_v1: "Do not allow",
      }),
    ).toEqual({ handled: true, approved: false });
    expect(() => assertStudyBuddyQuizApprovalGrant(payload())).toThrow("was not approved");

    captureStudyBuddyQuizApprovalRequest("thread-1", "native-request-2", [question()]);
    resolveStudyBuddyQuizApprovalResponse("thread-1", "native-request-2", {
      study_buddy_quiz_permission_v1: "Work on quiz (Recommended)",
    });
    expect(() =>
      assertStudyBuddyQuizApprovalGrant({
        ...payload(),
        targetUrl: "https://moodle.example.test/2",
      }),
    ).toThrow("was not approved");
  });

  it("rebuilds the pending proposal from the persisted native request activity", () => {
    const request = payload();
    captureStudyBuddyQuizApprovalActivity("thread-1", "native-request-1", {
      requestId: "native-request-1",
      questions: [question(request)],
    });
    expect(
      resolveStudyBuddyQuizApprovalResponse("thread-1", "native-request-1", {
        study_buddy_quiz_permission_v1: "Work on quiz (Recommended)",
      }),
    ).toEqual({ handled: true, approved: true });
    expect(() => assertStudyBuddyQuizApprovalGrant(request)).not.toThrow();
  });
});
