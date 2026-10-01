import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerSettings,
  type ServerProvider,
  type StudyBuddyBuiltInProfileId,
  type StudyBuddyCustomExecutionProfile,
  type StudyBuddyExecutionProfile,
  type StudyBuddyExecutionProfileDefinition,
  type StudyBuddyProfileRoles,
  type StudyBuddyWorkerRole,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "./model.ts";

import {
  STUDY_BUDDY_MODEL_TASKS,
  STUDY_BUDDY_TASK_ROLES,
  type StudyBuddyModelOperation,
} from "./studyBuddyModelTasks.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
export const STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID = "studyBuddyExecutionProfileId";

function worker(
  model: string,
  reasoningEffort: StudyBuddyProfileRoles["contentAnalyzer"]["reasoningEffort"],
  retryModel: string,
  retryReasoningEffort: StudyBuddyProfileRoles["contentAnalyzer"]["reasoningEffort"],
) {
  return { model, reasoningEffort, retryModel, retryReasoningEffort } as const;
}

export const STUDY_BUDDY_BUILT_IN_PROFILES: ReadonlyArray<StudyBuddyExecutionProfileDefinition> = [
  {
    id: "fast",
    name: "Fast",
    description: "Sol with light reasoning and Luna workers for quick drafts and direct answers.",
    kind: "built-in",
    icon: "zap",
    taskOverrides: {
      source_search: worker("gpt-6-luna", "medium", "gpt-6.1-sol", "medium"),
      content_repair: worker("gpt-6.1-sol", "high", "gpt-6-sol", "high"),
      artifact_repair: worker("gpt-6.1-sol", "high", "gpt-6-sol", "high"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-6.1-sol",
        reasoningEffort: "low",
      },
      contentAnalyzer: worker("gpt-6-luna", "medium", "gpt-6.1-sol", "high"),
      quizSolver: worker("gpt-6-luna", "high", "gpt-6.1-sol", "high"),
      artifactPlanner: worker("gpt-6-luna", "high", "gpt-6.1-sol", "high"),
      artifactBuilder: worker("gpt-6-luna", "high", "gpt-6.1-sol", "high"),
      qualityReviewer: worker("gpt-6.1-sol", "high", "gpt-6-sol", "medium"),
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Sol for dependable everyday study work, with Luna search and bounded fallbacks.",
    kind: "built-in",
    icon: "gauge",
    taskOverrides: {
      source_search: worker("gpt-6-luna", "medium", "gpt-6.1-sol", "medium"),
      content_repair: worker("gpt-6.1-sol", "high", "gpt-6-sol", "medium"),
      artifact_repair: worker("gpt-6.1-sol", "high", "gpt-6-sol", "xhigh"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
      },
      contentAnalyzer: worker("gpt-6.1-sol", "medium", "gpt-6-sol", "medium"),
      quizSolver: worker("gpt-6.1-sol", "high", "gpt-6-sol", "high"),
      artifactPlanner: worker("gpt-6.1-sol", "medium", "gpt-6-sol", "medium"),
      artifactBuilder: worker("gpt-6.1-sol", "medium", "gpt-6-sol", "high"),
      qualityReviewer: worker("gpt-6.1-sol", "medium", "gpt-6-sol", "medium"),
    },
  },
  {
    id: "quality",
    name: "Quality",
    description:
      "Astra for demanding reasoning, building, and review; uses higher-cost models than Balanced.",
    kind: "built-in",
    icon: "gem",
    taskOverrides: {
      source_search: worker("gpt-6-luna", "medium", "gpt-6.1-sol", "medium"),
      content_repair: worker("gpt-6-astra", "high", "gpt-6.1-sol", "xhigh"),
      artifact_repair: worker("gpt-6-astra", "high", "gpt-6.1-sol", "xhigh"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-6-astra",
        reasoningEffort: "low",
      },
      contentAnalyzer: worker("gpt-6.1-sol", "high", "gpt-6-astra", "medium"),
      quizSolver: worker("gpt-6-astra", "high", "gpt-6.1-sol", "xhigh"),
      artifactPlanner: worker("gpt-6-astra", "high", "gpt-6.1-sol", "xhigh"),
      artifactBuilder: worker("gpt-6-astra", "high", "gpt-6.1-sol", "xhigh"),
      qualityReviewer: worker("gpt-6-astra", "medium", "gpt-6.1-sol", "high"),
    },
  },
];

export function builtInStudyBuddyProfile(
  id: string | null | undefined,
): StudyBuddyExecutionProfileDefinition | undefined {
  const normalized = id === "auto" ? "balanced" : id;
  return STUDY_BUDDY_BUILT_IN_PROFILES.find((profile) => profile.id === normalized);
}

export type StudyBuddyProfileProvider = Pick<ServerProvider, "instanceId" | "driver" | "models">;

export function isStudyBuddyMixedProfile(profile: StudyBuddyExecutionProfileDefinition): boolean {
  const coordinator = profile.roles.coordinator.instanceId;
  return Object.values(studyBuddyProfileOverrides(profile)).some(
    (role) =>
      (role.instanceId ?? coordinator) !== coordinator ||
      (role.retryInstanceId ?? role.instanceId ?? coordinator) !== coordinator,
  );
}

export function availableStudyBuddyProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      ["codex", "antigravity", "claudeAgent"].includes(provider.driver) &&
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status === "authenticated" &&
      provider.models.length > 0,
  );
}

export function unavailableStudyBuddyProfileConnections(
  profile: StudyBuddyExecutionProfileDefinition,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceId> {
  const coordinator = profile.roles.coordinator.instanceId;
  const required = new Set<ProviderInstanceId>([coordinator]);
  for (const role of Object.values(studyBuddyProfileOverrides(profile))) {
    required.add(role.instanceId ?? coordinator);
    required.add(role.retryInstanceId ?? role.instanceId ?? coordinator);
  }
  const available = new Set(
    availableStudyBuddyProviders(providers).map((provider) => provider.instanceId),
  );
  return [...required].filter((id) => !available.has(id));
}

export function studyBuddyProviderLabel(driver: string): string {
  return (
    (
      { codex: "Codex", antigravity: "Google Gemini", claudeAgent: "Claude" } as Record<
        string,
        string
      >
    )[driver] ?? driver
  );
}

export function studyBuddyConnectionLabel(
  provider: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  return provider.instanceId === String(provider.driver)
    ? studyBuddyProviderLabel(provider.driver)
    : provider.displayName ||
        `${studyBuddyProviderLabel(provider.driver)} (${provider.instanceId})`;
}

/** Provider catalogues own model identifiers, including Gemini's opaque ACP ids. */
export function studyBuddyBuiltInProfiles(
  provider: StudyBuddyProfileProvider,
): ReadonlyArray<StudyBuddyExecutionProfileDefinition> {
  const models = provider.models.filter((model) => !model.isCustom);
  const sorted = [...(models.length ? models : provider.models)].sort(
    (a, b) =>
      b.name.localeCompare(a.name, "en", { numeric: true }) ||
      b.slug.localeCompare(a.slug, "en", { numeric: true }),
  );
  const flashVersion = (model: ServerProvider["models"][number]) =>
    /gemini[- ](\d+(?:\.\d+)*).*flash/i.exec(`${model.name} ${model.slug}`)?.[1];
  const flashModels = sorted.filter(
    (model) =>
      /flash/i.test(`${model.name} ${model.slug}`) &&
      !/lite|live|tts|cyber|image/i.test(`${model.name} ${model.slug}`),
  );
  const latestFlashVersion = flashModels
    .map(flashVersion)
    .filter((version): version is string => Boolean(version))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  const nativeModels =
    provider.driver === "antigravity" && flashModels.length > 0
      ? flashModels.filter(
          (model) => !latestFlashVersion || flashVersion(model) === latestFlashVersion,
        )
      : sorted;
  const pick = (patterns: ReadonlyArray<RegExp>, fallback: string): string => {
    for (const pattern of patterns) {
      const match = nativeModels.find((model) => pattern.test(`${model.name} ${model.slug}`));
      if (match) return match.slug;
    }
    return nativeModels[0]?.slug ?? fallback;
  };
  if (provider.driver === "codex") {
    // Account catalogues can lag rollouts. Every known catalogue selection stays usable.
    const select = (preferred: string, alternatives: ReadonlyArray<string>) =>
      sorted.length === 0
        ? preferred
        : ([preferred, ...alternatives].find((slug) =>
            sorted.some((model) => model.slug === slug),
          ) ?? sorted[0]!.slug);
    const replacements: Record<string, string> = {
      "gpt-6.1-sol": select("gpt-6.1-sol", ["gpt-6-sol", "gpt-5.6-terra", "gpt-5.6-sol"]),
      "gpt-6-sol": select("gpt-6-sol", ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra"]),
      "gpt-6-luna": select("gpt-6-luna", [
        "gpt-5.6-luna",
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-5.6-terra",
      ]),
      "gpt-6-astra": select("gpt-6-astra", [
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ]),
    };
    const adaptWorker = (role: StudyBuddyWorkerRole): StudyBuddyWorkerRole => ({
      ...role,
      model: replacements[role.model] ?? role.model,
      retryModel: replacements[role.retryModel] ?? role.retryModel,
    });
    return STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => ({
      ...profile,
      description: profile.description
        .replace(
          /Astra/g,
          replacements["gpt-6-astra"] === "gpt-6-astra" ? "Astra" : replacements["gpt-6-astra"]!,
        )
        .replace(
          /Sol/g,
          replacements["gpt-6.1-sol"] === "gpt-6.1-sol" ? "Sol" : replacements["gpt-6.1-sol"]!,
        )
        .replace(
          /Luna/g,
          replacements["gpt-6-luna"] === "gpt-6-luna" ? "Luna" : replacements["gpt-6-luna"]!,
        ),
      roles: {
        coordinator: {
          ...profile.roles.coordinator,
          model: replacements[profile.roles.coordinator.model]!,
          instanceId: provider.instanceId,
        },
        contentAnalyzer: adaptWorker(profile.roles.contentAnalyzer),
        quizSolver: adaptWorker(profile.roles.quizSolver),
        artifactPlanner: adaptWorker(profile.roles.artifactPlanner),
        artifactBuilder: adaptWorker(profile.roles.artifactBuilder),
        qualityReviewer: adaptWorker(profile.roles.qualityReviewer),
      },
      taskOverrides: Object.fromEntries(
        Object.entries(profile.taskOverrides ?? {}).map(([id, role]) => [id, adaptWorker(role)]),
      ),
    }));
  }
  const claude = provider.driver === "claudeAgent";
  const cheap = pick(
    claude ? [/haiku/i, /sonnet/i] : [/flash.*low/i, /flash.*medium/i, /flash/i],
    claude ? "claude-haiku-4-5" : "gemini-3.8-flash-low",
  );
  const medium = pick(
    claude ? [/sonnet/i, /haiku/i] : [/flash.*medium/i, /flash.*high/i, /flash/i],
    claude ? "claude-sonnet-4-6" : "gemini-3.8-flash-medium",
  );
  const high = pick(
    claude ? [/opus/i, /sonnet/i] : [/flash.*high/i, /flash/i, /pro.*high/i, /pro/i],
    claude ? "claude-opus-4-8" : "gemini-pro-agent",
  );
  const bases = claude
    ? STUDY_BUDDY_BUILT_IN_PROFILES
    : STUDY_BUDDY_BUILT_IN_PROFILES.filter((profile) => profile.id !== "quality");
  const profiles = bases.map((base): StudyBuddyExecutionProfileDefinition => {
    const fast = base.id === "fast";
    const quality = base.id === "quality";
    const effort = fast ? "low" : quality ? "high" : "medium";
    const effortForModel = (model: string) =>
      /low/i.test(model)
        ? "low"
        : /high/i.test(model)
          ? "high"
          : /medium/i.test(model)
            ? "medium"
            : effort;
    const role = (
      model: string,
      retryModel = model === high ? medium : high,
    ): StudyBuddyWorkerRole =>
      worker(
        model,
        claude ? effort : effortForModel(model),
        retryModel,
        claude ? "high" : effortForModel(retryModel),
      );
    return {
      ...base,
      description: claude
        ? `${base.name} study work using the available Claude model tiers.`
        : base.id === "fast"
          ? "Flash with lighter thinking for quick answers and drafts."
          : "Flash with medium coordination and deeper thinking for building and review.",
      roles: {
        coordinator: {
          instanceId: provider.instanceId,
          model: fast ? cheap : quality ? high : medium,
          reasoningEffort: claude ? effort : effortForModel(fast ? cheap : medium),
        },
        contentAnalyzer: role(fast ? cheap : quality ? high : medium),
        quizSolver: role(fast ? cheap : quality ? high : medium),
        artifactPlanner: role(fast ? cheap : quality ? high : medium),
        artifactBuilder: role(fast ? cheap : high),
        qualityReviewer: role(fast ? medium : high),
      },
      taskOverrides: {
        source_search: role(cheap, medium),
        content_repair: role(quality ? high : medium),
        artifact_repair: role(high),
      },
    };
  });
  // Without distinct model/thinking variants, multiple Gemini presets would be duplicates.
  return !claude && cheap === medium && medium === high
    ? profiles.filter((profile) => profile.id === "balanced")
    : profiles;
}

export function allStudyBuddyProfiles(
  customProfiles: ReadonlyArray<StudyBuddyCustomExecutionProfile>,
  provider?: StudyBuddyProfileProvider,
): ReadonlyArray<StudyBuddyExecutionProfileDefinition> {
  return [
    ...customProfiles.filter(
      (profile) =>
        !provider ||
        profile.roles.coordinator.instanceId === provider.instanceId ||
        isStudyBuddyMixedProfile(profile),
    ),
    ...(provider ? studyBuddyBuiltInProfiles(provider) : STUDY_BUDDY_BUILT_IN_PROFILES),
  ];
}

export function resolveStudyBuddyProfile(input: {
  activeProfileId?: string | null;
  legacyProfile?: StudyBuddyExecutionProfile | null;
  customProfiles?: ReadonlyArray<StudyBuddyCustomExecutionProfile>;
  provider?: StudyBuddyProfileProvider;
}): StudyBuddyExecutionProfileDefinition {
  const customProfiles = input.customProfiles ?? [];
  // Existing settings files only have the legacy enum. Its decoded default
  // makes the new id look like "balanced", so preserve a non-default legacy
  // choice until the UI writes both fields together.
  const requestedId =
    input.activeProfileId === "balanced" &&
    input.legacyProfile !== undefined &&
    input.legacyProfile !== null &&
    input.legacyProfile !== "auto" &&
    input.legacyProfile !== "balanced"
      ? input.legacyProfile
      : (input.activeProfileId ?? input.legacyProfile ?? "balanced");
  const builtIns = input.provider
    ? studyBuddyBuiltInProfiles(input.provider)
    : STUDY_BUDDY_BUILT_IN_PROFILES;
  const custom = customProfiles.find((profile) => profile.id === requestedId);
  return custom &&
    (!input.provider ||
      custom.roles.coordinator.instanceId === input.provider.instanceId ||
      isStudyBuddyMixedProfile(custom))
    ? custom
    : (builtIns.find(
        (profile) => profile.id === (requestedId === "auto" ? "balanced" : requestedId),
      ) ??
        builtIns.find((profile) => profile.id === input.legacyProfile) ??
        builtIns.find((profile) => profile.id === "balanced") ??
        builtIns[0]!);
}

export function resolveStudyBuddyProfileFromSettings(
  settings: Pick<
    ServerSettings,
    | "studyBuddyExecutionProfile"
    | "studyBuddyExecutionProfileId"
    | "studyBuddyCustomExecutionProfiles"
  >,
): StudyBuddyExecutionProfileDefinition {
  return resolveStudyBuddyProfile({
    activeProfileId: settings.studyBuddyExecutionProfileId,
    legacyProfile: settings.studyBuddyExecutionProfile,
    customProfiles: settings.studyBuddyCustomExecutionProfiles,
  });
}

export function studyBuddyProfileIdFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return getModelSelectionStringOptionValue(
    modelSelection,
    STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID,
  );
}

function reasoningFromModelSelection(modelSelection: ModelSelection): string | undefined {
  return getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
}

export function resolveStudyBuddyProfileForModelSelection(
  settings: Pick<
    ServerSettings,
    | "studyBuddyExecutionProfile"
    | "studyBuddyExecutionProfileId"
    | "studyBuddyCustomExecutionProfiles"
  > &
    Partial<Pick<ServerSettings, "providerInstances" | "studyBuddyProviderProfileIds">>,
  modelSelection: ModelSelection | null | undefined,
  options?: { preferDefault?: boolean; providers?: ReadonlyArray<StudyBuddyProfileProvider> },
): StudyBuddyExecutionProfileDefinition {
  const driver = modelSelection
    ? (settings.providerInstances?.[modelSelection.instanceId]?.driver ?? modelSelection.instanceId)
    : "codex";
  const provider = modelSelection
    ? {
        instanceId: modelSelection.instanceId,
        driver: driver as ServerProvider["driver"],
        models:
          options?.providers?.find((entry) => entry.instanceId === modelSelection.instanceId)
            ?.models ?? [],
      }
    : undefined;
  const explicitId = studyBuddyProfileIdFromModelSelection(modelSelection);
  if (!explicitId && modelSelection && !options?.preferDefault && driver === "codex") {
    const effort = reasoningFromModelSelection(modelSelection);
    const inferred = allStudyBuddyProfiles(
      settings.studyBuddyCustomExecutionProfiles,
      provider,
    ).find(
      (profile) =>
        profile.roles.coordinator.instanceId === modelSelection.instanceId &&
        profile.roles.coordinator.model === modelSelection.model &&
        (effort === undefined || profile.roles.coordinator.reasoningEffort === effort),
    );
    if (inferred) return inferred;
    // Profiles predating persisted ids used the old Sol/Terra coordinator matrix.
    const legacyId =
      modelSelection.model === "gpt-5.6-sol"
        ? "quality"
        : modelSelection.model === "gpt-5.6-terra"
          ? effort === "low"
            ? "fast"
            : "balanced"
          : undefined;
    if (legacyId)
      return resolveStudyBuddyProfile({
        activeProfileId: legacyId,
        ...(provider ? { provider } : {}),
      });
  }
  const defaultId =
    modelSelection && settings.studyBuddyProviderProfileIds?.[modelSelection.instanceId];
  return resolveStudyBuddyProfile({
    activeProfileId: explicitId ?? defaultId ?? settings.studyBuddyExecutionProfileId,
    ...(!explicitId && !defaultId ? { legacyProfile: settings.studyBuddyExecutionProfile } : {}),
    customProfiles: settings.studyBuddyCustomExecutionProfiles,
    ...(provider ? { provider } : {}),
  });
}

export function baseExecutionProfile(
  profile: StudyBuddyExecutionProfileDefinition,
): Exclude<StudyBuddyExecutionProfile, "auto"> {
  return profile.kind === "custom" ? "custom" : (profile.id as StudyBuddyBuiltInProfileId);
}

export function studyBuddyCoordinatorOptions(
  profile: StudyBuddyExecutionProfileDefinition,
  driver: string = profile.roles.coordinator.instanceId,
): ReadonlyArray<ProviderOptionSelection> {
  return [
    {
      id: driver === "claudeAgent" ? "effort" : "reasoningEffort",
      value: profile.roles.coordinator.reasoningEffort,
    },
    ...(profile.roles.coordinator.fastMode ? [{ id: "fastMode", value: true } as const] : []),
    { id: STUDY_BUDDY_EXECUTION_PROFILE_OPTION_ID, value: profile.id },
  ];
}

export function duplicateStudyBuddyProfile(
  source: StudyBuddyExecutionProfileDefinition,
  id: string,
): StudyBuddyCustomExecutionProfile {
  return {
    ...source,
    id,
    name: `${source.name} copy`.slice(0, 40),
    description: source.description,
    kind: "custom",
    ...(source.icon ? { icon: source.icon } : {}),
    taskOverrides: Object.fromEntries(
      Object.entries(source.taskOverrides ?? {}).map(([key, value]) => [key, { ...value }]),
    ),
    roles: {
      coordinator: { ...source.roles.coordinator },
      contentAnalyzer: { ...source.roles.contentAnalyzer },
      quizSolver: { ...source.roles.quizSolver },
      artifactPlanner: { ...source.roles.artifactPlanner },
      artifactBuilder: { ...source.roles.artifactBuilder },
      qualityReviewer: { ...source.roles.qualityReviewer },
    },
  };
}

export function resolveStudyBuddyTask(
  profile: StudyBuddyExecutionProfileDefinition,
  id: StudyBuddyModelOperation,
): {
  policy: StudyBuddyWorkerRole;
  source: string;
} {
  const task = STUDY_BUDDY_MODEL_TASKS.find((entry) => entry.id === id)!;
  const explicit = profile.taskOverrides?.[id];
  if (explicit) return { policy: explicit, source: "Task override" };
  const parent = profile.taskOverrides?.[task.task];
  if (parent) {
    const label =
      STUDY_BUDDY_MODEL_TASKS.find((entry) => entry.id === task.task)?.label ?? task.task;
    return { policy: parent, source: `Inherited from ${label}` };
  }
  return {
    policy: profile.roles[task.role],
    source: `Inherited from ${{ contentAnalyzer: "Content analyst", quizSolver: "Quiz solver", artifactPlanner: "Artifact planner", artifactBuilder: "Artifact builder", qualityReviewer: "Quality reviewer" }[task.role]}`,
  };
}

/** Only explicit policies cross the CLI boundary; task inheritance stays inspectable. */
export function studyBuddyProfileOverrides(
  profile: StudyBuddyExecutionProfileDefinition,
): Record<string, StudyBuddyWorkerRole> {
  return {
    ...Object.fromEntries(
      Object.entries(STUDY_BUDDY_TASK_ROLES)
        .filter(
          ([task]) =>
            task !== "source_search" && task !== "content_repair" && task !== "artifact_repair",
        )
        .map(([task, role]) => [task, profile.roles[role]]),
    ),
    ...profile.taskOverrides,
  };
}

/** Custom assignments are explicit; switching the connection never rewrites them. */
export function adaptStudyBuddyProfileToSelection(
  profile: StudyBuddyExecutionProfileDefinition,
  selection: ModelSelection,
  driver: string = selection.instanceId,
  models: ServerProvider["models"] = [],
): StudyBuddyExecutionProfileDefinition {
  if (profile.kind === "custom") return profile;
  return resolveStudyBuddyProfile({
    activeProfileId: profile.id,
    provider: {
      instanceId: selection.instanceId,
      driver: driver as ServerProvider["driver"],
      models,
    },
  });
}
