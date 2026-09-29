import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
import { describe, expect, it } from "vite-plus/test";

import { resolveQuickChatModelSelection } from "./quickChatModelSelection";

const codexProvider = (models: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.159.0",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt" },
  checkedAt: "2026-09-29T00:00:00.000Z",
  models: models.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

describe("resolveQuickChatModelSelection", () => {
  it("starts with the selected Study Buddy profile coordinator model", () => {
    const selection = resolveQuickChatModelSelection({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [codexProvider(["gpt-6.1-sol", "gpt-5.6-terra"])],
    });

    expect(selection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.6-terra",
      options: expect.arrayContaining([
        { id: "reasoningEffort", value: "medium" },
        { id: "studyBuddyExecutionProfileId", value: "balanced" },
      ]),
    });
  });

  it("falls back to the live provider catalog when a saved coordinator model is stale", () => {
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "custom-stale");
    const staleProfile = {
      ...profile,
      roles: {
        ...profile.roles,
        coordinator: { ...profile.roles.coordinator, model: "gpt-5.4" },
      },
    };

    const selection = resolveQuickChatModelSelection({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        studyBuddyExecutionProfile: "custom",
        studyBuddyExecutionProfileId: staleProfile.id,
        studyBuddyCustomExecutionProfiles: [staleProfile],
      },
      providers: [codexProvider(["gpt-6.1-sol", "gpt-6-sol"])],
    });

    expect(selection.model).toBe("gpt-6.1-sol");
    expect(selection.options).toContainEqual({
      id: "studyBuddyExecutionProfileId",
      value: "custom-stale",
    });
  });

  it("refuses to create a broken Quick Chat when no provider model is ready", () => {
    expect(() =>
      resolveQuickChatModelSelection({
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [{ ...codexProvider([]), auth: { status: "unauthenticated" } }],
      }),
    ).toThrow(/cannot start until an authenticated provider reports an available model/i);
  });
});
