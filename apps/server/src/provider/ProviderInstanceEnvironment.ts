import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

const STUDY_BUDDY_PRIVATE_ENVIRONMENT_NAMES = [
  /^MOODLE_/i,
  /^CIS_/i,
  /^STUDY_BUDDY_SOURCES_JSON$/i,
  /^STUDY_BUDDY_SOURCE_[A-Z0-9_]+_SECRET$/i,
] as const;

export function isStudyBuddyPrivateEnvironmentName(name: string): boolean {
  return STUDY_BUDDY_PRIVATE_ENVIRONMENT_NAMES.some((pattern) => pattern.test(name));
}

export function sanitizeProviderEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !isStudyBuddyPrivateEnvironmentName(name)),
  );
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = sanitizeProviderEnvironment(baseEnv);
  for (const variable of environment ?? []) {
    if (isStudyBuddyPrivateEnvironmentName(variable.name)) continue;
    next[variable.name] = variable.value;
  }
  return next;
}
