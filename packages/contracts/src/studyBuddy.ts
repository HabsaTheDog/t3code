import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const StudyBuddySecretPatch = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("unchanged") }),
  Schema.Struct({ operation: Schema.Literal("clear") }),
  Schema.Struct({
    operation: Schema.Literal("set"),
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  }),
]);
export type StudyBuddySecretPatch = typeof StudyBuddySecretPatch.Type;

export const StudyBuddyQuizSettings = Schema.Struct({
  accessMode: Schema.Literals(["review-only", "ask-before-attempt", "quiz-assist"]),
  minimumTimeLimitMinutes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  minimumAttemptsLeft: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  fillConfidenceThreshold: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type StudyBuddyQuizSettings = typeof StudyBuddyQuizSettings.Type;

export const StudyBuddyConfiguration = Schema.Struct({
  exists: Schema.Boolean,
  moodleUsername: Schema.String,
  moodleDashboardUrl: Schema.String,
  moodlePasswordConfigured: Schema.Boolean,
  cisUsername: Schema.String,
  cisUrl: Schema.String,
  cisPasswordConfigured: Schema.Boolean,
  calendarUrl: Schema.String,
  calendarUrlConfigured: Schema.Boolean,
  quiz: StudyBuddyQuizSettings,
});
export type StudyBuddyConfiguration = typeof StudyBuddyConfiguration.Type;

export const StudyBuddyConfigurationPatch = Schema.Struct({
  moodleUsername: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  moodleDashboardUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  moodlePassword: Schema.optionalKey(StudyBuddySecretPatch),
  cisUsername: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  cisUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  cisPassword: Schema.optionalKey(StudyBuddySecretPatch),
  calendarUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  calendarUrlSecret: Schema.optionalKey(StudyBuddySecretPatch),
  quiz: Schema.optionalKey(StudyBuddyQuizSettings),
});
export type StudyBuddyConfigurationPatch = typeof StudyBuddyConfigurationPatch.Type;

export const StudyBuddyUpdateConfigurationInput = Schema.Struct({
  patch: StudyBuddyConfigurationPatch,
});
export type StudyBuddyUpdateConfigurationInput = typeof StudyBuddyUpdateConfigurationInput.Type;

export const StudyBuddyConnectionTarget = Schema.Literals(["moodle", "cis", "calendar"]);
export type StudyBuddyConnectionTarget = typeof StudyBuddyConnectionTarget.Type;

export const StudyBuddyConnectionTestInput = Schema.Struct({
  target: StudyBuddyConnectionTarget,
});
export type StudyBuddyConnectionTestInput = typeof StudyBuddyConnectionTestInput.Type;

export const StudyBuddyConnectionTestResult = Schema.Struct({
  target: StudyBuddyConnectionTarget,
  status: Schema.Literals(["success", "failure"]),
  code: Schema.Literals([
    "ok",
    "not-configured",
    "credentials-not-configured",
    "timeout",
    "authentication-failed",
    "invalid-calendar",
    "unreachable",
  ]),
  message: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export type StudyBuddyConnectionTestResult = typeof StudyBuddyConnectionTestResult.Type;

export const StudyBuddyExecutionProfile = Schema.Literals([
  "auto",
  "fast",
  "balanced",
  "quality",
  "custom",
]);
export type StudyBuddyExecutionProfile = typeof StudyBuddyExecutionProfile.Type;

export const STUDY_BUDDY_BUILT_IN_PROFILE_IDS = ["fast", "balanced", "quality"] as const;
export const STUDY_BUDDY_MAX_CUSTOM_PROFILES = 10;
export const STUDY_BUDDY_PROFILE_ICONS = [
  "zap",
  "gauge",
  "gem",
  "book-open",
  "brain",
  "flask-conical",
  "graduation-cap",
  "calculator",
  "chart",
  "telescope",
  "microscope",
  "atom",
  "lightbulb",
  "puzzle",
  "target",
  "rocket",
  "wand",
  "library",
  "notebook",
  "workflow",
] as const;

export const StudyBuddyBuiltInProfileId = Schema.Literals(STUDY_BUDDY_BUILT_IN_PROFILE_IDS);
export type StudyBuddyBuiltInProfileId = typeof StudyBuddyBuiltInProfileId.Type;

export const StudyBuddyProfileId = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type StudyBuddyProfileId = typeof StudyBuddyProfileId.Type;

export const StudyBuddyProfileIcon = Schema.Literals(STUDY_BUDDY_PROFILE_ICONS);
export type StudyBuddyProfileIcon = typeof StudyBuddyProfileIcon.Type;

export const StudyBuddyReasoningEffort = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type StudyBuddyReasoningEffort = typeof StudyBuddyReasoningEffort.Type;

const StudyBuddyModelSlug = TrimmedNonEmptyString.check(Schema.isMaxLength(160));

export const StudyBuddyCoordinatorRole = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: StudyBuddyModelSlug,
  reasoningEffort: StudyBuddyReasoningEffort,
  fastMode: Schema.optionalKey(Schema.Boolean),
});
export type StudyBuddyCoordinatorRole = typeof StudyBuddyCoordinatorRole.Type;

export const StudyBuddyWorkerRole = Schema.Struct({
  model: StudyBuddyModelSlug,
  reasoningEffort: StudyBuddyReasoningEffort,
  retryModel: StudyBuddyModelSlug,
  retryReasoningEffort: StudyBuddyReasoningEffort,
});
export type StudyBuddyWorkerRole = typeof StudyBuddyWorkerRole.Type;

const DefaultStudyBuddyQuizSolverRole = StudyBuddyWorkerRole.pipe(
  Schema.withDecodingDefault(
    Effect.succeed({
      model: "gpt-5.6-terra",
      reasoningEffort: "high" as const,
      retryModel: "gpt-5.6-sol",
      retryReasoningEffort: "high" as const,
    }),
  ),
);

export const StudyBuddyProfileRoles = Schema.Struct({
  coordinator: StudyBuddyCoordinatorRole,
  contentAnalyzer: StudyBuddyWorkerRole,
  quizSolver: DefaultStudyBuddyQuizSolverRole,
  artifactPlanner: StudyBuddyWorkerRole,
  artifactBuilder: StudyBuddyWorkerRole,
  qualityReviewer: StudyBuddyWorkerRole,
});
export type StudyBuddyProfileRoles = typeof StudyBuddyProfileRoles.Type;

export const StudyBuddyExecutionProfileDefinition = Schema.Struct({
  id: StudyBuddyProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  description: Schema.String.check(Schema.isMaxLength(180)),
  kind: Schema.Literals(["built-in", "custom"]),
  icon: Schema.optionalKey(StudyBuddyProfileIcon),
  roles: StudyBuddyProfileRoles,
});
export type StudyBuddyExecutionProfileDefinition = typeof StudyBuddyExecutionProfileDefinition.Type;

export const StudyBuddyCustomExecutionProfile = Schema.Struct({
  id: StudyBuddyProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  description: Schema.String.check(Schema.isMaxLength(180)),
  kind: Schema.Literal("custom"),
  icon: Schema.optionalKey(StudyBuddyProfileIcon),
  roles: StudyBuddyProfileRoles,
});
export type StudyBuddyCustomExecutionProfile = typeof StudyBuddyCustomExecutionProfile.Type;

export const StudyBuddyCustomExecutionProfiles = Schema.Array(
  StudyBuddyCustomExecutionProfile,
).check(Schema.isMaxLength(STUDY_BUDDY_MAX_CUSTOM_PROFILES));
export type StudyBuddyCustomExecutionProfiles = typeof StudyBuddyCustomExecutionProfiles.Type;

export class StudyBuddyConfigurationError extends Schema.TaggedErrorClass<StudyBuddyConfigurationError>()(
  "StudyBuddyConfigurationError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
