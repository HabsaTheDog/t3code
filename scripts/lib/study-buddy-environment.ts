const PRIVATE_STUDY_BUDDY_ENVIRONMENT_NAMES = [
  /^MOODLE_/i,
  /^CIS_/i,
  /^STUDY_BUDDY_SOURCES_JSON$/i,
  /^STUDY_BUDDY_SOURCE_[A-Z0-9_]+_SECRET$/i,
] as const;

const LINUX_DESKTOP_ENVIRONMENT_NAMES = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
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

export function parseLinuxDesktopEnvironment(output: string): NodeJS.ProcessEnv {
  const allowedNames = new Set<string>(LINUX_DESKTOP_ENVIRONMENT_NAMES);
  const environment: NodeJS.ProcessEnv = {};

  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (allowedNames.has(name) && value.trim().length > 0) {
      environment[name] = value;
    }
  }

  return environment;
}

export function mergeMissingLinuxDesktopEnvironment(
  environment: NodeJS.ProcessEnv,
  desktopEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const merged = { ...environment };
  if (platform !== "linux") {
    return merged;
  }

  for (const name of LINUX_DESKTOP_ENVIRONMENT_NAMES) {
    if (merged[name]?.trim()) {
      continue;
    }

    const value = desktopEnvironment[name];
    if (value?.trim()) {
      merged[name] = value;
    }
  }

  return merged;
}
