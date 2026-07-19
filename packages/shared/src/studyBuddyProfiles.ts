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
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "./model.ts";

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
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        fastMode: true,
      },
      contentAnalyzer: worker("gpt-5.6-luna", "high", "gpt-5.6-terra", "high"),
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
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      contentAnalyzer: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "high"),
      quizSolver: worker("gpt-5.6-terra", "high", "gpt-5.6-sol", "high"),
      artifactPlanner: worker("gpt-5.6-terra", "medium", "gpt-5.6-sol", "medium"),
      artifactBuilder: worker("gpt-5.6-sol", "medium", "gpt-5.6-sol", "high"),
      qualityReviewer: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
    },
  },
  {
    id: "quality",
    name: "Quality",
    description: "Deeper planning, construction, and review for final or difficult work.",
    kind: "built-in",
    icon: "gem",
    roles: {
      coordinator: {
        instanceId: codexInstanceId,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      contentAnalyzer: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      quizSolver: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      artifactPlanner: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      artifactBuilder: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
      qualityReviewer: worker("gpt-5.6-sol", "high", "gpt-5.6-sol", "xhigh"),
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
  >,
  modelSelection: ModelSelection | null | undefined,
  options?: { preferDefault?: boolean },
): StudyBuddyExecutionProfileDefinition {
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
