import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  StudyBuddyCustomExecutionProfile,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allStudyBuddyProfiles,
  duplicateStudyBuddyProfile,
  resolveStudyBuddyTask,
  studyBuddyProfileOverrides,
  resolveStudyBuddyProfile,
  resolveStudyBuddyProfileForModelSelection,
  STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID,
  STUDY_BUDDY_BUILT_IN_PROFILES,
  studyBuddyCoordinatorOptions,
  studyBuddyBuiltInProfiles,
  adaptStudyBuddyProfileToSelection,
  isStudyBuddyMixedProfile,
} from "./studyBuddyProfiles.ts";

const decodeCustomProfile = Schema.decodeUnknownSync(StudyBuddyCustomExecutionProfile);

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
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      retryModel: "gpt-6-sol",
      retryReasoningEffort: "high",
    });
  });

  it("uses a role-specific model matrix instead of one model per profile", () => {
    const [fast, balanced, quality] = STUDY_BUDDY_BUILT_IN_PROFILES;

    expect(fast?.roles).toMatchObject({
      coordinator: { model: "gpt-6.1-sol", reasoningEffort: "low" },
      contentAnalyzer: {
        model: "gpt-6-luna",
        reasoningEffort: "medium",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "high",
      },
      quizSolver: {
        model: "gpt-6-luna",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "high",
      },
      artifactPlanner: {
        model: "gpt-6-luna",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "high",
      },
      artifactBuilder: {
        model: "gpt-6-luna",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "high",
      },
      qualityReviewer: {
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "medium",
      },
    });
    expect(balanced?.roles).toMatchObject({
      coordinator: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
      contentAnalyzer: {
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "medium",
      },
      quizSolver: {
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "high",
      },
      artifactPlanner: {
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "medium",
      },
      artifactBuilder: {
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "high",
      },
      qualityReviewer: {
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        retryModel: "gpt-6-sol",
        retryReasoningEffort: "medium",
      },
    });
    expect(quality?.roles).toMatchObject({
      coordinator: { model: "gpt-6-astra", reasoningEffort: "low" },
      contentAnalyzer: {
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        retryModel: "gpt-6-astra",
        retryReasoningEffort: "medium",
      },
      quizSolver: {
        model: "gpt-6-astra",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "xhigh",
      },
      artifactPlanner: {
        model: "gpt-6-astra",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "xhigh",
      },
      artifactBuilder: {
        model: "gpt-6-astra",
        reasoningEffort: "high",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "xhigh",
      },
      qualityReviewer: {
        model: "gpt-6-astra",
        reasoningEffort: "medium",
        retryModel: "gpt-6.1-sol",
        retryReasoningEffort: "high",
      },
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
      { id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: "fast" },
    ]);
    expect(resolved.roles.coordinator.model).toBe("gpt-6.1-sol");
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
        model: "gpt-6-astra",
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

describe("task assignments", () => {
  it("inherits roles, honors specialized overrides, and resets without changing sibling tasks", () => {
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "custom-test");
    const specialized = {
      ...profile.roles.contentAnalyzer,
      model: "gpt-solutions",
      retryModel: "gpt-verify",
    };
    const changed = {
      ...profile,
      taskOverrides: { ...profile.taskOverrides, solution_generation: specialized },
    };
    expect(resolveStudyBuddyTask(changed, "solution_generation")).toEqual({
      policy: specialized,
      source: "Task override",
    });
    expect(resolveStudyBuddyTask(changed, "content_extraction").policy).toEqual(
      profile.roles.contentAnalyzer,
    );
    const { solution_generation: _removed, ...remaining } = changed.taskOverrides;
    const reset = { ...changed, taskOverrides: remaining };
    expect(resolveStudyBuddyTask(reset, "solution_generation").policy).toEqual(
      profile.roles.contentAnalyzer,
    );
    expect(resolveStudyBuddyTask(changed, "learning_content_repair").policy).toEqual(
      profile.taskOverrides!.content_repair,
    );
    expect(profile.taskOverrides).not.toBe(STUDY_BUDDY_BUILT_IN_PROFILES[1]!.taskOverrides);
    expect(profile.taskOverrides!.content_repair).not.toBe(
      STUDY_BUDDY_BUILT_IN_PROFILES[1]!.taskOverrides!.content_repair,
    );
  });

  it("hands off built-in search/repair settings and custom task settings", () => {
    const profile = STUDY_BUDDY_BUILT_IN_PROFILES[0]!;
    expect(studyBuddyProfileOverrides(profile)).toMatchObject({
      content_analyzer: profile.roles.contentAnalyzer,
      source_search: profile.taskOverrides!.source_search,
      content_repair: profile.taskOverrides!.content_repair,
      artifact_repair: profile.taskOverrides!.artifact_repair,
    });
  });
});

describe("profile persistence", () => {
  it("decodes old profiles and round-trips overrides without flattening inherited tasks", () => {
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "custom-schema");
    const { taskOverrides: _overrides, ...legacy } = profile;
    const decode = Schema.decodeUnknownSync(StudyBuddyCustomExecutionProfile);
    expect(decode(legacy).taskOverrides).toBeUndefined();
    const changed = {
      ...legacy,
      taskOverrides: {
        solution_generation: { ...legacy.roles.contentAnalyzer, model: "gpt-specialist" },
      },
    };
    expect(decode(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    expect(() =>
      decode({ ...changed, taskOverrides: { solution_generation: { model: "" } } }),
    ).toThrow();
  });
});

describe("native provider execution policies", () => {
  it.each(["claudeAgent", "antigravity"])(
    "resolves %s profiles from its catalogue with distinct tiers",
    (driver) => {
      const instanceId = ProviderInstanceId.make(`custom-${driver}`);
      const slugs =
        driver === "claudeAgent"
          ? ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]
          : ["gemini-flash-low", "gemini-flash-medium", "gemini-pro-high"];
      const provider = {
        instanceId,
        driver: ProviderDriverKind.make(driver),
        models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
      };
      const profiles = studyBuddyBuiltInProfiles(provider);
      expect(profiles.map((profile) => profile.roles.coordinator.model)).toEqual(
        driver === "claudeAgent" ? slugs : slugs.slice(0, 2),
      );
      for (const profile of profiles) {
        expect(profile.roles.coordinator.instanceId).toBe(instanceId);
        for (const policy of Object.values(studyBuddyProfileOverrides(profile))) {
          expect(slugs).toContain(policy.model);
          expect(slugs).toContain(policy.retryModel);
        }
      }
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver: provider.driver } },
      };
      const resolved = resolveStudyBuddyProfileForModelSelection(
        settings,
        {
          instanceId,
          model: slugs[0]!,
          options: [{ id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: "quality" }],
        },
        { providers: [provider] },
      );
      expect(resolved).toEqual(driver === "claudeAgent" ? profiles[2] : profiles[1]);
    },
  );

  it("preserves explicit mixed assignments when selecting a native coordinator", () => {
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "mixed");
    const mixed = {
      ...profile,
      roles: {
        ...profile.roles,
        artifactBuilder: {
          ...profile.roles.artifactBuilder,
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-pro",
          retryInstanceId: ProviderInstanceId.make("claudeAgent"),
          retryModel: "claude-sonnet",
        },
      },
    };
    expect(isStudyBuddyMixedProfile(mixed)).toBe(true);
    expect(
      adaptStudyBuddyProfileToSelection(mixed, {
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "gemini",
      }),
    ).toBe(mixed);
    expect(
      allStudyBuddyProfiles([profile, mixed], {
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        models: [],
      })
        .filter((profile) => profile.kind === "custom")
        .map((profile) => profile.id),
    ).toEqual(["mixed"]);
    expect(decodeCustomProfile(JSON.parse(JSON.stringify(mixed)))).toEqual(mixed);
  });
  it("preserves the GPT role policies for a custom Codex instance", () => {
    const instanceId = ProviderInstanceId.make("work-codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: { driver: ProviderDriverKind.make("codex") } },
    };
    const profile = resolveStudyBuddyProfileForModelSelection(settings, {
      instanceId,
      model: "gpt-6.1-sol",
      options: [{ id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: "quality" }],
    });
    expect(profile.roles.artifactBuilder.model).toBe("gpt-6-astra");
  });
});

describe("catalogue-aware current profile defaults", () => {
  const catalogue = (driver: string, slugs: string[]) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  });
  it("uses only offered Codex models when current families have not rolled out", () => {
    const provider = catalogue("codex", ["gpt-5.6-terra", "gpt-5.6-luna"]);
    for (const profile of studyBuddyBuiltInProfiles(provider)) {
      expect(provider.models.map((model) => model.slug)).toContain(profile.roles.coordinator.model);
      for (const role of Object.values(studyBuddyProfileOverrides(profile))) {
        expect(provider.models.map((model) => model.slug)).toContain(role.model);
        expect(provider.models.map((model) => model.slug)).toContain(role.retryModel);
      }
    }
    expect(studyBuddyBuiltInProfiles(provider)[2]!.description).not.toContain("Astra");
  });
  it("reserves Astra for Quality and leaves automatic fast billing off", () => {
    const provider = catalogue("codex", ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]);
    const profiles = studyBuddyBuiltInProfiles(provider);
    expect(profiles.map((profile) => profile.roles.coordinator.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol",
      "gpt-6-astra",
    ]);
    for (const profile of profiles.slice(0, 2)) {
      expect(profile.roles.coordinator.fastMode).not.toBe(true);
      expect(
        Object.values(studyBuddyProfileOverrides(profile)).some(
          (role) => role.model === "gpt-6-astra" || role.retryModel === "gpt-6-astra",
        ),
      ).toBe(false);
    }
  });
  it("uses latest Flash thinking variants for two Gemini presets without an older Pro tier", () => {
    const provider = catalogue("antigravity", [
      "gemini-3.7-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "gemini-pro-agent",
    ]);
    const profiles = studyBuddyBuiltInProfiles(provider);
    expect(profiles.map((profile) => profile.id)).toEqual(["fast", "balanced"]);
    for (const profile of profiles) {
      for (const role of Object.values(studyBuddyProfileOverrides(profile))) {
        expect(role.model).toMatch(/^gemini-3.8-flash/);
        expect(role.retryModel).toMatch(/^gemini-3.8-flash/);
      }
    }
    expect(profiles[1]!.roles.artifactBuilder).toMatchObject({
      model: "gemini-3.8-flash-high",
      reasoningEffort: "high",
      retryModel: "gemini-3.8-flash-medium",
      retryReasoningEffort: "medium",
    });
    expect(resolveStudyBuddyProfile({ activeProfileId: "quality", provider })).toEqual(profiles[1]);
  });
  it("collapses Gemini to Balanced when only one Flash model exists and resolves old ids safely", () => {
    const provider = catalogue("antigravity", [
      "gemini-3.8-flash",
      "gemini-3.7-flash-low",
      "gemini-pro-agent",
    ]);
    expect(studyBuddyBuiltInProfiles(provider).map((profile) => profile.id)).toEqual(["balanced"]);
    for (const id of ["fast", "balanced", "quality", "auto", "missing"]) {
      expect(
        resolveStudyBuddyProfile({ activeProfileId: id, provider }).roles.coordinator.model,
      ).toBe("gemini-3.8-flash");
    }
    expect(
      adaptStudyBuddyProfileToSelection(
        STUDY_BUDDY_BUILT_IN_PROFILES[2]!,
        { instanceId: provider.instanceId, model: "gemini-3.8-flash" },
        provider.driver,
        provider.models,
      ).id,
    ).toBe("balanced");
  });
  it("keeps saved custom model assignments intact during a built-in refresh", () => {
    const custom = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "saved-custom");
    const saved = {
      ...custom,
      roles: {
        ...custom.roles,
        coordinator: { ...custom.roles.coordinator, model: "gpt-5.6-terra" },
      },
    };
    const provider = catalogue("codex", ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]);
    expect(
      resolveStudyBuddyProfile({ activeProfileId: saved.id, customProfiles: [saved], provider }),
    ).toBe(saved);
  });
});
