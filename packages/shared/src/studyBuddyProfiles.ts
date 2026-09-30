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
    description: "Quick drafts and direct answers with the lowest practical latency.",
    kind: "built-in",
    icon: "zap",
    taskOverrides: {
      source_search: worker("gpt-5.6-luna", "medium", "gpt-5.6-terra", "medium"),
      content_repair: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "high"),
      artifact_repair: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "high"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        fastMode: true,
      },
      contentAnalyzer: worker("gpt-5.6-luna", "medium", "gpt-5.6-terra", "high"),
      quizSolver: worker("gpt-5.6-luna", "high", "gpt-5.6-terra", "high"),
      artifactPlanner: worker("gpt-5.6-luna", "high", "gpt-5.6-terra", "high"),
      artifactBuilder: worker("gpt-5.6-luna", "high", "gpt-5.6-terra", "high"),
      qualityReviewer: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "medium"),
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "The normal balance of speed, cost, and dependable study quality.",
    kind: "built-in",
    icon: "gauge",
    taskOverrides: {
      source_search: worker("gpt-5.6-luna", "medium", "gpt-5.6-terra", "medium"),
      content_repair: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "medium"),
      artifact_repair: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      contentAnalyzer: worker("gpt-5.6-terra", "medium", "gpt-5.6-sol", "medium"),
      quizSolver: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "high"),
      artifactPlanner: worker("gpt-5.6-terra", "medium", "gpt-5.6-sol", "medium"),
      artifactBuilder: worker("gpt-5.6-sol", "medium", "gpt-5.6-terra", "high"),
      qualityReviewer: worker("gpt-5.6-terra", "medium", "gpt-5.6-terra", "medium"),
    },
  },
  {
    id: "quality",
    name: "Quality",
    description: "Deeper planning, construction, and review for final or difficult work.",
    kind: "built-in",
    icon: "gem",
    taskOverrides: {
      source_search: worker("gpt-5.6-luna", "medium", "gpt-5.6-terra", "medium"),
      content_repair: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      artifact_repair: worker("gpt-5.6-sol", "xhigh", "gpt-5.6-sol", "xhigh"),
    },
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      contentAnalyzer: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "medium"),
      quizSolver: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      artifactPlanner: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      artifactBuilder: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      qualityReviewer: worker("gpt-5.6-terra", "high", "gpt-5.6-terra", "high"),
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
  const pick = (patterns: ReadonlyArray<RegExp>, fallback: string): string => {
    for (const pattern of patterns) {
      const match = sorted.find((model) => pattern.test(`${model.name} ${model.slug}`));
      if (match) return match.slug;
    }
    return sorted[0]?.slug ?? fallback;
  };
  if (provider.driver === "codex") {
    return STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => ({
      ...profile,
      roles: {
        ...profile.roles,
        coordinator: { ...profile.roles.coordinator, instanceId: provider.instanceId },
      },
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
    claude ? [/opus/i, /sonnet/i] : [/pro.*high/i, /pro/i, /flash.*high/i, /flash/i],
    claude ? "claude-opus-4-8" : "gemini-pro-agent",
  );
  return STUDY_BUDDY_BUILT_IN_PROFILES.map((base) => {
    const fast = base.id === "fast";
    const quality = base.id === "quality";
    const effort = fast ? "low" : quality ? "high" : "medium";
    const role = (
      model: string,
      retryModel = model === high ? medium : high,
    ): StudyBuddyWorkerRole => worker(model, effort, retryModel, "high");
    return {
      ...base,
      roles: {
        coordinator: {
          instanceId: provider.instanceId,
          model: fast ? cheap : quality ? high : medium,
          reasoningEffort: effort,
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
        builtIns[1]!);
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
  return studyBuddyBuiltInProfiles({
    instanceId: selection.instanceId,
    driver: driver as ServerProvider["driver"],
    models,
  }).find((candidate) => candidate.id === profile.id)!;
}
