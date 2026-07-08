import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export class StudyBuddyConfigurationError extends Schema.TaggedErrorClass<StudyBuddyConfigurationError>()(
  "StudyBuddyConfigurationError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
