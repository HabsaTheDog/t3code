const PRIVATE_STUDY_BUDDY_ENVIRONMENT_NAMES = [
  /^MOODLE_/i,
  /^CIS_/i,
  /^STUDY_BUDDY_SOURCES_JSON$/i,
  /^STUDY_BUDDY_SOURCE_[A-Z0-9_]+_SECRET$/i,
] as const;

export function sanitizeStudyBuddyHostEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !PRIVATE_STUDY_BUDDY_ENVIRONMENT_NAMES.some((pattern) => pattern.test(name)),
    ),
  );
}
