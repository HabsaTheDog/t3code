import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerSettings,
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
      artifactBuilder: worker("gpt-5.6-sol", "medium", "gpt-5.6-sol", "high"),
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

export function allStudyBuddyProfiles(
  customProfiles: ReadonlyArray<StudyBuddyCustomExecutionProfile>,
): ReadonlyArray<StudyBuddyExecutionProfileDefinition> {
  return [...customProfiles, ...STUDY_BUDDY_BUILT_IN_PROFILES];
}

export function resolveStudyBuddyProfile(input: {
  activeProfileId?: string | null;
  legacyProfile?: StudyBuddyExecutionProfile | null;
  customProfiles?: ReadonlyArray<StudyBuddyCustomExecutionProfile>;
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
  return (
    customProfiles.find((profile) => profile.id === requestedId) ??
    builtInStudyBuddyProfile(requestedId) ??
    builtInStudyBuddyProfile(input.legacyProfile) ??
    STUDY_BUDDY_BUILT_IN_PROFILES[1]!
  );
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
    Partial<Pick<ServerSettings, "providerInstances">>,
  modelSelection: ModelSelection | null | undefined,
  options?: { preferDefault?: boolean },
): StudyBuddyExecutionProfileDefinition {
  // Built-in execution policies follow the selected provider. A custom policy
  // remains explicit; native providers must never receive GPT worker models.
  const driver = modelSelection
    ? (settings.providerInstances?.[modelSelection.instanceId]?.driver ?? modelSelection.instanceId)
    : undefined;
  if (modelSelection && driver !== "codex") {
    const base = resolveStudyBuddyProfile({
      activeProfileId:
        studyBuddyProfileIdFromModelSelection(modelSelection) ??
        settings.studyBuddyExecutionProfileId,
      customProfiles: settings.studyBuddyCustomExecutionProfiles,
    });
    return adaptStudyBuddyProfileToSelection(base, modelSelection, driver);
  }
  const explicitId = studyBuddyProfileIdFromModelSelection(modelSelection);
  if (explicitId) {
    return resolveStudyBuddyProfile({
      activeProfileId: explicitId,
      customProfiles: settings.studyBuddyCustomExecutionProfiles,
    });
  }

  if (modelSelection && !options?.preferDefault) {
    const effort = reasoningFromModelSelection(modelSelection);
    const candidates = allStudyBuddyProfiles(settings.studyBuddyCustomExecutionProfiles);
    const inferred = candidates.find(
      (profile) =>
        profile.roles.coordinator.instanceId === modelSelection.instanceId &&
        profile.roles.coordinator.model === modelSelection.model &&
        (effort === undefined || profile.roles.coordinator.reasoningEffort === effort),
    );
    if (inferred) return inferred;
  }

  return resolveStudyBuddyProfileFromSettings(settings);
}

export function baseExecutionProfile(
  profile: StudyBuddyExecutionProfileDefinition,
): Exclude<StudyBuddyExecutionProfile, "auto"> {
  return profile.kind === "custom" ? "custom" : (profile.id as StudyBuddyBuiltInProfileId);
}

export function studyBuddyCoordinatorOptions(
  profile: StudyBuddyExecutionProfileDefinition,
): ReadonlyArray<ProviderOptionSelection> {
  return [
    { id: "reasoningEffort", value: profile.roles.coordinator.reasoningEffort },
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

/** Keep all native worker roles on the exact provider/model selected by the user. */
export function adaptStudyBuddyProfileToSelection(
  profile: StudyBuddyExecutionProfileDefinition,
  selection: ModelSelection,
  driver: string = selection.instanceId,
): StudyBuddyExecutionProfileDefinition {
  if (driver === "codex") return profile;
  const adapt = (role: StudyBuddyWorkerRole): StudyBuddyWorkerRole => ({
    ...role,
    model: selection.model,
    retryModel: selection.model,
  });
  return {
    ...profile,
    roles: {
      coordinator: {
        ...profile.roles.coordinator,
        instanceId: selection.instanceId,
        model: selection.model,
        fastMode: false,
      },
      contentAnalyzer: adapt(profile.roles.contentAnalyzer),
      quizSolver: adapt(profile.roles.quizSolver),
      artifactPlanner: adapt(profile.roles.artifactPlanner),
      artifactBuilder: adapt(profile.roles.artifactBuilder),
      qualityReviewer: adapt(profile.roles.qualityReviewer),
    },
    taskOverrides: Object.fromEntries(
      Object.entries(profile.taskOverrides ?? {}).map(([key, role]) => [key, adapt(role)]),
    ),
  };
}
