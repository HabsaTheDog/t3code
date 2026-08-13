import { describe, expect, it } from "vite-plus/test";

import {
  hasUserAuthoredDraftContent,
  joinWorkspacePath,
  resolveStudyBuddyOpenPath,
  shouldCleanupUnpromptedQuickChat,
} from "./studyBuddyWorkspace.ts";

describe("Study Buddy workspace paths", () => {
  it("opens every Quick Chat integration at its deliverables directory", () => {
    expect(
      resolveStudyBuddyOpenPath({
        cwd: "/tmp/quick-chats/thread-1",
        projectKind: "quick-chat",
      }),
    ).toBe("/tmp/quick-chats/thread-1/study-buddy-deliverables");
    expect(
      resolveStudyBuddyOpenPath({
        cwd: String.raw`C:\Quick Chats\thread-1`,
        projectKind: "quick-chat",
      }),
    ).toBe(String.raw`C:\Quick Chats\thread-1\study-buddy-deliverables`);
  });

  it("leaves regular project and worktree targets unchanged", () => {
    expect(resolveStudyBuddyOpenPath({ cwd: "/repo/worktree", projectKind: "regular" })).toBe(
      "/repo/worktree",
    );
    expect(resolveStudyBuddyOpenPath({ cwd: null, projectKind: "quick-chat" })).toBeNull();
  });

  it("joins workspace paths without duplicate separators", () => {
    expect(joinWorkspacePath("/tmp/quick-chats/", "/thread-1/", "deliverables")).toBe(
      "/tmp/quick-chats/thread-1/deliverables",
    );
  });
});

describe("Quick Chat draft cleanup eligibility", () => {
  const emptyDraft = {
    prompt: "",
    images: [],
    persistedAttachments: [],
    terminalContexts: [],
  };

  it("treats missing and untouched drafts as having no user-authored content", () => {
    expect(hasUserAuthoredDraftContent(null)).toBe(false);
    expect(hasUserAuthoredDraftContent(emptyDraft)).toBe(false);
  });

  it("preserves drafts with text or attachments", () => {
    expect(hasUserAuthoredDraftContent({ ...emptyDraft, prompt: "Explain this" })).toBe(true);
    expect(hasUserAuthoredDraftContent({ ...emptyDraft, images: [{}] })).toBe(true);
    expect(hasUserAuthoredDraftContent({ ...emptyDraft, persistedAttachments: [{}] })).toBe(true);
    expect(hasUserAuthoredDraftContent({ ...emptyDraft, terminalContexts: [{}] })).toBe(true);
  });

  it("never cleans up a prompted text-only thread just because it has no artifacts", () => {
    expect(
      shouldCleanupUnpromptedQuickChat({
        threadCount: 1,
        hasDraftReservation: true,
        isSubmitting: false,
        draft: emptyDraft,
      }),
    ).toBe(false);
  });

  it("cleans up only an unprompted draft without user-authored content", () => {
    expect(
      shouldCleanupUnpromptedQuickChat({
        threadCount: 0,
        hasDraftReservation: true,
        isSubmitting: false,
        draft: emptyDraft,
      }),
    ).toBe(true);
    expect(
      shouldCleanupUnpromptedQuickChat({
        threadCount: 0,
        hasDraftReservation: true,
        isSubmitting: false,
        draft: { ...emptyDraft, prompt: "Not sent yet" },
      }),
    ).toBe(false);
    expect(
      shouldCleanupUnpromptedQuickChat({
        threadCount: 0,
        hasDraftReservation: false,
        isSubmitting: false,
        draft: null,
      }),
    ).toBe(false);
    expect(
      shouldCleanupUnpromptedQuickChat({
        threadCount: 0,
        hasDraftReservation: true,
        isSubmitting: true,
        draft: emptyDraft,
      }),
    ).toBe(false);
  });
});
