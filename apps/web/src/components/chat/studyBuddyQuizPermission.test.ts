import { describe, expect, it } from "vitest";

import {
  formatStudyBuddyQuizTime,
  isStudyBuddyQuizPermissionQuestion,
  parseStudyBuddyQuizPermissionQuestion,
  STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID,
} from "./studyBuddyQuizPermission";

describe("Study Buddy quiz permission prompt", () => {
  it("parses the complete structured native permission payload", () => {
    const details = parseStudyBuddyQuizPermissionQuestion({
      id: STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID,
      header: "Quiz access",
      question: JSON.stringify({
        version: 1,
        owner: "study-buddy",
        action: "execute_quiz_attempt",
        quizTitle: "Elektrotechnik 2: 1. Selbstcheck",
        targetUrl: "https://moodle.example/mod/quiz/view.php?id=7",
        expiresAt: "2026-07-17T20:00:00.000Z",
        metadata: {
          timeLimitMinutes: 15,
          effectiveTimeLimitMinutes: 15,
          effectiveTimeLimitSource: "quiz_time_limit",
          timeLimitUnlimited: false,
          attemptsAllowed: 3,
          attemptsUsed: 1,
          attemptsLeft: 2,
          attemptsUnlimited: false,
          hasActiveAttempt: true,
          canStartNewAttempt: false,
          availabilityStatus: "open",
          opensAt: "2026-07-17T18:00:00.000Z",
          closesAt: "2026-07-17T22:00:00.000Z",
        },
        capabilities: ["read_questions", "fill_answers", "save_or_next_page"],
        finalQuizSubmission: "denied",
      }),
      options: [
        { label: "Work on quiz", description: "Allow" },
        { label: "Do not allow", description: "Decline" },
      ],
      multiSelect: false,
    });

    expect(details).toMatchObject({
      quizTitle: "Elektrotechnik 2: 1. Selbstcheck",
      timeLimitMinutes: 15,
      effectiveTimeLimitMinutes: 15,
      effectiveTimeLimitSource: "quiz_time_limit",
      timeLimitUnlimited: false,
      attemptsAllowed: 3,
      attemptsUsed: 1,
      attemptsLeft: 2,
      attemptsUnlimited: false,
      hasActiveAttempt: true,
      canStartNewAttempt: false,
      availabilityStatus: "open",
      opensAt: "2026-07-17T18:00:00.000Z",
      closesAt: "2026-07-17T22:00:00.000Z",
      finalQuizSubmissionDenied: true,
    });
  });

  it("upgrades the legacy prose prompt shown by existing sessions", () => {
    const question = {
      id: "quiz-permission",
      header: "Quiz freigeben",
      question:
        "Der gefundene Selbstcheck ist „ET2: 1. Selbstcheck | FHTW Moodle“. Zeitlimit: keines bekannt; Versuche übrig: unbekannt; ein Versuch ist bereits aktiv. Erlaubnisse: Versuch starten/fortsetzen, Fragen lesen, Antworten eintragen sowie sicher speichern/weiterblättern. Die finale Abgabe bleibt gesperrt.",
      options: [
        { label: "Approve this quiz", description: "Approve" },
        { label: "Decline", description: "Decline" },
      ],
      multiSelect: false,
    };

    expect(isStudyBuddyQuizPermissionQuestion(question)).toBe(true);
    expect(parseStudyBuddyQuizPermissionQuestion(question)).toMatchObject({
      quizTitle: "ET2: 1. Selbstcheck | FHTW Moodle",
      timeLimitMinutes: null,
      effectiveTimeLimitMinutes: null,
      effectiveTimeLimitSource: "unlimited",
      timeLimitUnlimited: true,
      attemptsLeft: null,
      attemptsUnlimited: true,
      hasActiveAttempt: true,
      finalQuizSubmissionDenied: true,
    });
  });

  it("treats absent structured attempt limits as unlimited", () => {
    const details = parseStudyBuddyQuizPermissionQuestion({
      id: STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID,
      header: "Quiz access",
      question: JSON.stringify({
        version: 1,
        owner: "study-buddy",
        action: "execute_quiz_attempt",
        quizTitle: "Übungsquiz",
        metadata: { availabilityStatus: "open" },
        capabilities: ["read_questions"],
        finalQuizSubmission: "denied",
      }),
      options: [
        { label: "Work on quiz", description: "Allow" },
        { label: "Do not allow", description: "Decline" },
      ],
      multiSelect: false,
    });

    expect(details).toMatchObject({
      timeLimitMinutes: null,
      effectiveTimeLimitMinutes: null,
      timeLimitUnlimited: true,
      attemptsAllowed: null,
      attemptsLeft: null,
      attemptsUnlimited: true,
    });
  });

  it("keeps an otherwise untimed quiz bounded by its closing deadline", () => {
    const details = parseStudyBuddyQuizPermissionQuestion({
      id: STUDY_BUDDY_QUIZ_PERMISSION_QUESTION_ID,
      header: "Quiz access",
      question: JSON.stringify({
        version: 1,
        owner: "study-buddy",
        action: "execute_quiz_attempt",
        quizTitle: "Übungsquiz",
        metadata: {
          timeLimitMinutes: null,
          effectiveTimeLimitMinutes: 30,
          effectiveTimeLimitSource: "deadline",
          timeLimitUnlimited: false,
          closesAt: "2026-07-17T12:30:00.000Z",
          availabilityStatus: "open",
        },
        capabilities: ["read_questions"],
        finalQuizSubmission: "denied",
      }),
      options: [
        { label: "Work on quiz", description: "Allow" },
        { label: "Do not allow", description: "Decline" },
      ],
      multiSelect: false,
    });

    expect(details).toMatchObject({
      timeLimitMinutes: null,
      effectiveTimeLimitMinutes: 30,
      effectiveTimeLimitSource: "deadline",
      timeLimitUnlimited: false,
      closesAt: "2026-07-17T12:30:00.000Z",
    });
    if (!details) throw new Error("Expected parsed quiz permission details");
    expect(formatStudyBuddyQuizTime(details)).toContain("30 min · until");
    expect(formatStudyBuddyQuizTime(details)).toContain("17/07/2026");
    expect(
      formatStudyBuddyQuizTime({
        ...details,
        timeLimitMinutes: 20,
        effectiveTimeLimitMinutes: 20,
        effectiveTimeLimitSource: "quiz_time_limit",
      }),
    ).toContain("20 min · closes");
    expect(
      formatStudyBuddyQuizTime({
        ...details,
        timeLimitMinutes: null,
        effectiveTimeLimitMinutes: null,
        effectiveTimeLimitSource: "unlimited",
        timeLimitUnlimited: true,
        closesAt: null,
      }),
    ).toBe("Unlimited");
  });

  it("leaves unrelated user-input prompts on the generic renderer", () => {
    expect(
      parseStudyBuddyQuizPermissionQuestion({
        id: "scope",
        header: "Scope",
        question: "What should this change cover?",
        options: [{ label: "Tight", description: "Small change" }],
        multiSelect: false,
      }),
    ).toBeNull();
  });
});
