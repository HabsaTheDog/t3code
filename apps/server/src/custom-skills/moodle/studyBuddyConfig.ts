// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StudyBuddyConfigurationError,
  type StudyBuddyConfiguration,
  type StudyBuddyConfigurationPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ServerSecretStoreShape } from "../../auth/ServerSecretStore.ts";
import type { ServerConfigShape } from "../../config.ts";
import {
  getSourceSecret,
  removeSourceSecret,
  setSourceSecret,
  type SourceSecret,
} from "../sources/sourceSecretStorage.ts";

const DEFAULT_MOODLE_URL = "https://moodle.technikum-wien.at/my/";
const DEFAULT_CIS_URL = "https://cis.technikum-wien.at/cis.php/";

const CONFIG_KEYS = {
  moodleUsername: "MOODLE_USERNAME",
  moodlePassword: "MOODLE_PASSWORD",
  moodleUrl: "MOODLE_DASHBOARD_URL",
  moodleBaseUrl: "MOODLE_BASE_URL",
  cisUsername: "CIS_USERNAME",
  cisPassword: "CIS_PASSWORD",
  cisUrl: "CIS_URLS",
  calendarUrl: "CIS_CALENDAR_URL",
  quizMode: "MOODLE_QUIZ_ACCESS_MODE",
  quizMinimumMinutes: "MOODLE_QUIZ_MIN_TIME_LIMIT_MINUTES",
  quizMinimumAttempts: "MOODLE_QUIZ_MIN_ATTEMPTS_LEFT",
  quizConfidence: "MOODLE_QUIZ_FILL_CONFIDENCE_THRESHOLD",
  quizFinalSubmit: "MOODLE_QUIZ_BLOCK_FINAL_SUBMIT",
} as const;

export interface StoredStudyBuddyConfiguration {
  readonly envPath: string;
  readonly exists: boolean;
  readonly raw: string;
  readonly values: Readonly<Record<string, string>>;
}

export function resolveStudyBuddyEnvPath(config: ServerConfigShape): string {
  const root = process.env.STUDY_BUDDY_ROOT
    ? path.resolve(process.env.STUDY_BUDDY_ROOT)
    : process.env.STUDY_BUDDY_T3_ROOT
      ? path.resolve(process.env.STUDY_BUDDY_T3_ROOT, "..")
      : path.basename(config.cwd) === "t3code-fork"
        ? path.resolve(config.cwd, "..")
        : path.resolve(config.cwd);
  return path.join(root, ".env.local");
}

export function parseEnvDocument(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match?.[1]) continue;
    values[match[1]] = parseEnvValue(match[2] ?? "");
  }
  return values;
}

export async function readStoredStudyBuddyConfiguration(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
): Promise<StoredStudyBuddyConfiguration> {
  const envPath = resolveStudyBuddyEnvPath(config);
  let stored: StoredStudyBuddyConfiguration;
  try {
    const raw = await readFile(envPath, "utf8");
    stored = { envPath, exists: true, raw, values: parseEnvDocument(raw) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      stored = { envPath, exists: false, raw: "", values: {} };
    } else {
      throw error;
    }
  }

  const values = { ...stored.values };
  const legacySecrets = legacySecretsFromValues(values);
  for (const [connectionId, secret] of legacySecrets) {
    if (!(await getSourceSecret(config, secrets, connectionId))) {
      await setSourceSecret(config, secrets, connectionId, secret);
      const verified = await getSourceSecret(config, secrets, connectionId);
      if (!verified || JSON.stringify(verified) !== JSON.stringify(secret)) {
        throw new Error("Legacy Study Buddy credential migration verification failed.");
      }
    }
  }
  if (legacySecrets.length > 0) {
    await clearLegacyStudyBuddySourceCredentials(stored);
    const sanitizedRaw = await readFile(envPath, "utf8");
    stored = { envPath, exists: true, raw: sanitizedRaw, values: parseEnvDocument(sanitizedRaw) };
  }

  const moodle = await getSourceSecret(config, secrets, "legacy-moodle-connection");
  const cis = await getSourceSecret(config, secrets, "legacy-cis-connection");
  const calendar = await getSourceSecret(config, secrets, "legacy-calendar-connection");
  return {
    ...stored,
    values: {
      ...stored.values,
      ...(moodle?.type === "password"
        ? { MOODLE_USERNAME: moodle.username, MOODLE_PASSWORD: moodle.password }
        : {}),
      ...(cis?.type === "password"
        ? { CIS_USERNAME: cis.username, CIS_PASSWORD: cis.password }
        : {}),
      ...(calendar?.type === "bearer-url" ? { CIS_CALENDAR_URL: calendar.value } : {}),
    },
  };
}

export function publicStudyBuddyConfiguration(
  stored: StoredStudyBuddyConfiguration,
): StudyBuddyConfiguration {
  const values = stored.values;
  return {
    exists: stored.exists,
    moodleUsername: values[CONFIG_KEYS.moodleUsername] ?? "",
    moodleDashboardUrl: publicUrl(values[CONFIG_KEYS.moodleUrl] ?? DEFAULT_MOODLE_URL),
    moodlePasswordConfigured: hasSecret(values[CONFIG_KEYS.moodlePassword]),
    cisUsername: values[CONFIG_KEYS.cisUsername] ?? "",
    cisUrl: publicUrl(firstUrl(values[CONFIG_KEYS.cisUrl]) ?? DEFAULT_CIS_URL),
    cisPasswordConfigured: hasSecret(values[CONFIG_KEYS.cisPassword]),
    // A private iCalendar URL is a bearer credential. Only expose its status;
    // connection tests and the runtime consume the value inside the server.
    calendarUrl: "",
    calendarUrlConfigured: hasSecret(values[CONFIG_KEYS.calendarUrl]),
    quiz: {
      accessMode: parseQuizMode(values[CONFIG_KEYS.quizMode]),
      minimumTimeLimitMinutes: parseNumberInRange(values[CONFIG_KEYS.quizMinimumMinutes], 10, 0),
      minimumAttemptsLeft: parseNumberInRange(values[CONFIG_KEYS.quizMinimumAttempts], 2, 0),
      fillConfidenceThreshold: parseNumberInRange(values[CONFIG_KEYS.quizConfidence], 0.85, 0, 1),
    },
  };
}

export const readStudyBuddyConfiguration = (
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
) =>
  Effect.tryPromise({
    try: async () =>
      publicStudyBuddyConfiguration(await readStoredStudyBuddyConfiguration(config, secrets)),
    catch: () =>
      new StudyBuddyConfigurationError({
        message: "Failed to read Study Buddy configuration.",
      }),
  });

export const updateStudyBuddyConfiguration = (
  config: ServerConfigShape,
  patch: StudyBuddyConfigurationPatch,
  secrets: ServerSecretStoreShape,
) =>
  Effect.tryPromise({
    try: async () => {
      const stored = await readStoredStudyBuddyConfiguration(config, secrets);
      await applyEncryptedSecretPatch(config, secrets, stored.values, patch);
      const updates = buildUpdates(patch);
      const nextRaw = patchEnvDocument(stored.raw, updates);
      await writeOwnerOnly(stored.envPath, nextRaw);
      return publicStudyBuddyConfiguration(
        await readStoredStudyBuddyConfiguration(config, secrets),
      );
    },
    catch: (cause) =>
      new StudyBuddyConfigurationError({
        message:
          cause instanceof Error && cause.message.startsWith("Invalid ")
            ? cause.message
            : "Failed to update Study Buddy configuration.",
      }),
  });

/**
 * Remove source credentials from the legacy dotenv document only after the
 * caller has persisted and verified their encrypted replacements.
 */
export async function clearLegacyStudyBuddySourceCredentials(
  stored: StoredStudyBuddyConfiguration,
): Promise<void> {
  if (!stored.exists) return;
  const nextRaw = patchEnvDocument(stored.raw, {
    [CONFIG_KEYS.moodleUsername]: "",
    [CONFIG_KEYS.moodlePassword]: "",
    [CONFIG_KEYS.cisUsername]: "",
    [CONFIG_KEYS.cisPassword]: "",
    [CONFIG_KEYS.calendarUrl]: "",
  });
  await writeOwnerOnly(stored.envPath, nextRaw);
}

function buildUpdates(patch: StudyBuddyConfigurationPatch): Readonly<Record<string, string>> {
  const updates: Record<string, string> = {};
  updates[CONFIG_KEYS.moodleUsername] = "";
  updates[CONFIG_KEYS.moodlePassword] = "";
  updates[CONFIG_KEYS.cisUsername] = "";
  updates[CONFIG_KEYS.cisPassword] = "";
  updates[CONFIG_KEYS.calendarUrl] = "";
  if (patch.moodleDashboardUrl !== undefined) {
    const url = validatePublicUrl("Moodle URL", patch.moodleDashboardUrl);
    updates[CONFIG_KEYS.moodleUrl] = url;
    updates[CONFIG_KEYS.moodleBaseUrl] = url ? new URL(url).origin : "";
  }
  if (patch.cisUrl !== undefined) {
    updates[CONFIG_KEYS.cisUrl] = validatePublicUrl("CIS URL", patch.cisUrl);
  }
  if (patch.quiz) {
    updates[CONFIG_KEYS.quizMode] = patch.quiz.accessMode;
    updates[CONFIG_KEYS.quizMinimumMinutes] = String(patch.quiz.minimumTimeLimitMinutes);
    updates[CONFIG_KEYS.quizMinimumAttempts] = String(patch.quiz.minimumAttemptsLeft);
    updates[CONFIG_KEYS.quizConfidence] = String(patch.quiz.fillConfidenceThreshold);
    updates[CONFIG_KEYS.quizFinalSubmit] = "true";
  }
  return updates;
}

function legacySecretsFromValues(
  values: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, SourceSecret]> {
  const secrets: Array<readonly [string, SourceSecret]> = [];
  if (values.MOODLE_USERNAME || values.MOODLE_PASSWORD) {
    secrets.push([
      "legacy-moodle-connection",
      {
        type: "password",
        username: values.MOODLE_USERNAME ?? "",
        password: values.MOODLE_PASSWORD ?? "",
      },
    ]);
  }
  if (values.CIS_USERNAME || values.CIS_PASSWORD) {
    secrets.push([
      "legacy-cis-connection",
      {
        type: "password",
        username: values.CIS_USERNAME ?? "",
        password: values.CIS_PASSWORD ?? "",
      },
    ]);
  }
  if (values.CIS_CALENDAR_URL) {
    secrets.push([
      "legacy-calendar-connection",
      { type: "bearer-url", value: validateCalendarUrl(values.CIS_CALENDAR_URL) },
    ]);
  }
  return secrets;
}

async function applyEncryptedSecretPatch(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
  current: Readonly<Record<string, string>>,
  patch: StudyBuddyConfigurationPatch,
): Promise<void> {
  if (patch.moodleUsername !== undefined || patch.moodlePassword) {
    const username = patch.moodleUsername ?? current.MOODLE_USERNAME ?? "";
    const password =
      !patch.moodlePassword || patch.moodlePassword.operation === "unchanged"
        ? (current.MOODLE_PASSWORD ?? "")
        : patch.moodlePassword.operation === "clear"
          ? ""
          : patch.moodlePassword.value;
    if (!username && !password) {
      await removeSourceSecret(secrets, "legacy-moodle-connection");
    } else {
      await setSourceSecret(config, secrets, "legacy-moodle-connection", {
        type: "password",
        username,
        password,
      });
    }
  }

  if (patch.cisUsername !== undefined || patch.cisPassword) {
    const username = patch.cisUsername ?? current.CIS_USERNAME ?? "";
    const password =
      !patch.cisPassword || patch.cisPassword.operation === "unchanged"
        ? (current.CIS_PASSWORD ?? "")
        : patch.cisPassword.operation === "clear"
          ? ""
          : patch.cisPassword.value;
    if (!username && !password) {
      await removeSourceSecret(secrets, "legacy-cis-connection");
    } else {
      await setSourceSecret(config, secrets, "legacy-cis-connection", {
        type: "password",
        username,
        password,
      });
    }
  }

  const calendarPatch =
    patch.calendarUrlSecret ??
    (patch.calendarUrl !== undefined
      ? patch.calendarUrl
        ? ({ operation: "set", value: patch.calendarUrl } as const)
        : ({ operation: "clear" } as const)
      : undefined);
  if (calendarPatch && calendarPatch.operation !== "unchanged") {
    if (calendarPatch.operation === "clear") {
      await removeSourceSecret(secrets, "legacy-calendar-connection");
    } else {
      await setSourceSecret(config, secrets, "legacy-calendar-connection", {
        type: "bearer-url",
        value: validateCalendarUrl(calendarPatch.value),
      });
    }
  }
}

function validateCalendarUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/^webcal:\/\//i, "https://");
  const parsed = new URL(normalized);
  const hasCredentialQuery = [...parsed.searchParams.keys()].some(isCredentialParameter);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || hasCredentialQuery) {
    throw new Error("Invalid calendar URL: use HTTPS without embedded credentials.");
  }
  return trimmed;
}

export function patchEnvDocument(
  original: string,
  updates: Readonly<Record<string, string>>,
): string {
  const remaining = new Map(Object.entries(updates));
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output: string[] = [];
  const written = new Set<string>();
  for (const line of lines) {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !Object.hasOwn(updates, key)) {
      output.push(line);
      continue;
    }
    if (written.has(key)) continue;
    output.push(`${key}=${formatEnvValue(updates[key] ?? "")}`);
    written.add(key);
    remaining.delete(key);
  }
  if (remaining.size > 0 && output.length > 0 && output.at(-1) !== "") output.push("");
  for (const [key, value] of remaining) output.push(`${key}=${formatEnvValue(value)}`);
  return `${output.join("\n").replace(/\n+$/g, "")}\n`;
}

async function writeOwnerOnly(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

function validatePublicUrl(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  const hasCredentialQuery = [...parsed.searchParams.keys()].some(isCredentialParameter);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    hasCredentialQuery
  ) {
    throw new Error(`Invalid ${label}: use HTTPS without embedded credentials.`);
  }
  return parsed.toString();
}

function publicUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    const credentialKeys = Array.from(parsed.searchParams.keys()).filter(isCredentialParameter);
    for (const key of credentialKeys) {
      if (isCredentialParameter(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function isCredentialParameter(value: string): boolean {
  return /(?:token|secret|password|passwd|api[_-]?key|auth|credential)/i.test(value);
}

function firstUrl(value: string | undefined): string | null {
  return value?.split(/[\s,]+/).find(Boolean) ?? null;
}

function hasSecret(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function parseNumberInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function parseQuizMode(value: string | undefined): StudyBuddyConfiguration["quiz"]["accessMode"] {
  return value === "info-only"
    ? "review-only"
    : value === "ask-before-attempt" || value === "quiz-assist" || value === "review-only"
      ? value
      : "review-only";
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "").trim();
}

function formatEnvValue(value: string): string {
  return value === "" ? "" : /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
