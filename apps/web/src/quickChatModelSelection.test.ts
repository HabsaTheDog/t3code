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

  it("automatically chooses a sole Gemini connection and resolves its tier", () => {
    const gemini = {
      ...codexProvider(["gemini-flash-low", "gemini-flash-medium", "gemini-pro-high"]),
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
    };
    expect(
      resolveQuickChatModelSelection({
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [
          { ...codexProvider(["gpt-5.6-terra"]), auth: { status: "unauthenticated" } },
          gemini,
        ],
      }),
    ).toMatchObject({ instanceId: "antigravity", model: "gemini-flash-medium" });
  });

  it("remembers separate defaults and refuses disconnected mixed assignments", () => {
    const gemini = {
      ...codexProvider(["gemini-flash-low", "gemini-flash-medium", "gemini-pro-high"]),
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      studyBuddyDefaultProviderInstanceId: gemini.instanceId,
      studyBuddyProviderProfileIds: { codex: "fast", antigravity: "quality" },
    };
    expect(
      resolveQuickChatModelSelection({
        settings,
        providers: [codexProvider(["gpt-5.6-terra"]), gemini],
      }),
    ).toMatchObject({ instanceId: "antigravity", model: "gemini-pro-high" });
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "mixed-missing");
    const mixed = {
      ...profile,
      roles: {
        ...profile.roles,
        artifactBuilder: {
          ...profile.roles.artifactBuilder,
          instanceId: ProviderInstanceId.make("claudeAgent"),
        },
      },
    };
    expect(() =>
      resolveQuickChatModelSelection({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          studyBuddyProviderProfileIds: { [ProviderInstanceId.make("codex")]: mixed.id },
          studyBuddyCustomExecutionProfiles: [mixed],
        },
        providers: [codexProvider(["gpt-5.6-terra"])],
      }),
    ).toThrow(/disconnected connections: claudeAgent/);
  });

  it("keeps the default connection when a legacy mixed profile belongs to another coordinator", () => {
    const gemini = {
      ...codexProvider(["gemini-flash-low", "gemini-flash-medium", "gemini-pro-high"]),
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
    };
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "legacy-mixed");
    const mixed = {
      ...profile,
      roles: {
        ...profile.roles,
        artifactBuilder: { ...profile.roles.artifactBuilder, instanceId: gemini.instanceId },
      },
    };
    expect(
      resolveQuickChatModelSelection({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          studyBuddyDefaultProviderInstanceId: gemini.instanceId,
          studyBuddyExecutionProfileId: mixed.id,
          studyBuddyCustomExecutionProfiles: [mixed],
        },
        providers: [codexProvider(["gpt-5.6-terra"]), gemini],
      }),
    ).toMatchObject({
      instanceId: "antigravity",
      model: "gemini-flash-medium",
      options: expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "balanced" }]),
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
