import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allStudyBuddyProfiles,
  resolveStudyBuddyProfile,
  resolveStudyBuddyProfileForModelSelection,
  STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID,
  STUDY_BUDDY_BUILT_IN_PROFILES,
  studyBuddyCoordinatorOptions,
} from "./studyBuddyProfiles.ts";

describe("Study Buddy execution profiles", () => {
  it("keeps the three built-ins in fast, balanced, quality order", () => {
    expect(STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => profile.id)).toEqual([
      "fast",
      "balanced",
      "quality",
    ]);
    expect(STUDY_BUDDY_BUILT_IN_PROFILES.every((profile) => profile.kind === "built-in")).toBe(
      true,
    );
    expect(Object.keys(STUDY_BUDDY_BUILT_IN_PROFILES[1]!.roles)).toEqual([
      "coordinator",
      "contentAnalyzer",
      "quizSolver",
      "artifactPlanner",
      "artifactBuilder",
      "qualityReviewer",
    ]);
    expect(STUDY_BUDDY_BUILT_IN_PROFILES[1]!.roles.quizSolver).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      retryModel: "gpt-5.6-sol",
      retryReasoningEffort: "high",
    });
  });

  it("uses a role-specific model matrix instead of one model per profile", () => {
    const [fast, balanced, quality] = STUDY_BUDDY_BUILT_IN_PROFILES;

    expect(fast?.roles).toMatchObject({
      coordinator: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      contentAnalyzer: { model: "gpt-5.6-luna", retryModel: "gpt-5.6-terra" },
      quizSolver: { model: "gpt-5.6-luna", retryModel: "gpt-5.6-terra" },
      artifactPlanner: { model: "gpt-5.6-luna", retryModel: "gpt-5.6-terra" },
      artifactBuilder: { model: "gpt-5.6-luna", retryModel: "gpt-5.6-terra" },
      qualityReviewer: { model: "gpt-5.6-terra", retryModel: "gpt-5.6-sol" },
    });
    expect(balanced?.roles).toMatchObject({
      coordinator: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      contentAnalyzer: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      quizSolver: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      artifactPlanner: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      artifactBuilder: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      qualityReviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    });
    expect(quality?.roles).toMatchObject({
      coordinator: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      contentAnalyzer: { model: "gpt-5.6-sol", retryReasoningEffort: "xhigh" },
      quizSolver: { model: "gpt-5.6-sol", retryReasoningEffort: "xhigh" },
      artifactPlanner: { model: "gpt-5.6-sol", retryReasoningEffort: "xhigh" },
      artifactBuilder: { model: "gpt-5.6-sol", retryReasoningEffort: "xhigh" },
      qualityReviewer: { model: "gpt-5.6-sol", retryReasoningEffort: "xhigh" },
    });
  });

  it("places custom profiles before the built-ins", () => {
    const custom = {
      ...STUDY_BUDDY_BUILT_IN_PROFILES[1]!,
      id: "my-profile",
      name: "My profile",
      kind: "custom" as const,
      roles: {
        ...STUDY_BUDDY_BUILT_IN_PROFILES[1]!.roles,
        coordinator: {
          ...STUDY_BUDDY_BUILT_IN_PROFILES[1]!.roles.coordinator,
          instanceId: ProviderInstanceId.make("codex"),
        },
      },
    };

    expect(allStudyBuddyProfiles([custom]).map((profile) => profile.id)).toEqual([
      "my-profile",
      "fast",
      "balanced",
      "quality",
    ]);
  });

  it("migrates a non-default legacy choice and exposes coordinator options", () => {
    const resolved = resolveStudyBuddyProfile({
      activeProfileId: "balanced",
      legacyProfile: "fast",
    });

    expect(resolved.id).toBe("fast");
    expect(studyBuddyCoordinatorOptions(resolved)).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
      { id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: "fast" },
    ]);
    expect(resolved.roles.coordinator.model).toBe("gpt-5.6-terra");
  });

  it("prefers a chat's persisted profile over the default setting", () => {
    const resolved = resolveStudyBuddyProfileForModelSelection(
      {
        studyBuddyExecutionProfile: "fast",
        studyBuddyExecutionProfileId: "fast",
        studyBuddyCustomExecutionProfiles: [],
      },
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: "quality" },
        ],
      },
    );

    expect(resolved.id).toBe("quality");
  });

  it("infers the profile for chats saved before profile ids were persisted", () => {
    const resolved = resolveStudyBuddyProfileForModelSelection(
      {
        studyBuddyExecutionProfile: "fast",
        studyBuddyExecutionProfileId: "fast",
        studyBuddyCustomExecutionProfiles: [],
      },
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    );

    expect(resolved.id).toBe("quality");
  });
});
