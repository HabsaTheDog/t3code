// @effect-diagnostics nodeBuiltinImport:off - Private, bounded native crash journal boundary.
// @effect-diagnostics globalDate:off - Imperative persisted-journal timestamps shared with Promise-based IPC.
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopHealthEventSchema, type DesktopHealthEvent } from "@t3tools/contracts";
import {
  classifyTelemetryFailure,
  TELEMETRY_CONSENT_VERSION,
} from "@t3tools/shared/telemetryHealth";
import { DesktopEnvironment, type DesktopEnvironmentShape } from "./DesktopEnvironment.ts";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const decode = Schema.decodeUnknownSync(Schema.Array(DesktopHealthEventSchema));
let pending: Promise<unknown> = Promise.resolve();
const serial = <T>(run: () => Promise<T>): Promise<T> => {
  const result = pending.then(run);
  pending = result.catch(() => undefined);
  return result;
};
type Environment = Pick<
  DesktopEnvironmentShape,
  "clientSettingsPath" | "stateDir" | "appVersion" | "platform"
>;
const journalPath = (environment: Environment) =>
  path.join(environment.stateDir, "telemetry-health.json");

async function consentSince(environment: Environment): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(environment.clientSettingsPath, "utf8"));
    const settings = raw.settings ?? raw;
    const since = Date.parse(settings.analyticsEnabledAt);
    return settings.consentVersion === TELEMETRY_CONSENT_VERSION &&
      settings.analyticsConsent === "accepted" &&
      Number.isFinite(since) &&
      since <= Date.now()
      ? since
      : null;
  } catch {
    return null;
  }
}

async function read(environment: Environment): Promise<DesktopHealthEvent[]> {
  const file = journalPath(environment);
  const since = await consentSince(environment);
  if (since === null) {
    await unlink(file).catch(() => undefined);
    return [];
  }
  try {
    if ((await stat(file)).size > 128 * 1024) return [];
    return decode(JSON.parse(await readFile(file, "utf8")))
      .filter((entry) => {
        const time = Date.parse(entry.timestamp);
        return time >= Math.max(since, Date.now() - MAX_AGE_MS) && time <= Date.now();
      })
      .slice(-64);
  } catch {
    return [];
  }
}

async function write(environment: Environment, events: ReadonlyArray<DesktopHealthEvent>) {
  const file = journalPath(environment);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(events.slice(-64)), { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export const readDesktopHealthEvents = (environment: Environment) =>
  serial(() => read(environment));
export const acknowledgeDesktopHealthEvents = (
  environment: Environment,
  ids: ReadonlyArray<string>,
) =>
  serial(async () => {
    const entries = await read(environment);
    if ((await consentSince(environment)) === null) return;
    await write(
      environment,
      entries.filter((entry) => !ids.includes(entry.id)),
    );
  });

export const recordDesktopHealthFailure = (
  component: string,
  message: string,
  annotations?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    if (!["desktop-startup", "desktop-backend-manager", "desktop-updater"].includes(component))
      return;
    const environment = yield* Effect.serviceOption(DesktopEnvironment);
    if (Option.isNone(environment)) return;
    const env = environment.value;
    yield* Effect.promise(() =>
      serial(async () => {
        const since = await consentSince(env);
        if (since === null) {
          await read(env);
          return;
        }
        const detail = [message, annotations?.message, annotations?.error, annotations?.cause]
          .filter((item) => typeof item === "string")
          .join(" ");
        const failureKind = classifyTelemetryFailure(detail);
        const event =
          component === "desktop-updater" ? "desktop.update_failed" : "desktop.startup_failed";
        const failureStage =
          component === "desktop-updater"
            ? typeof annotations?.failureStage === "string" &&
              ["install", "download", "check"].includes(annotations.failureStage)
              ? annotations.failureStage
              : /install/i.test(message)
                ? "install"
                : /download/i.test(message)
                  ? "download"
                  : "check"
            : component === "desktop-startup"
              ? "startup"
              : "backend";
        const entries = await read(env);
        const previous = entries.at(-1);
        if (
          previous?.event === event &&
          previous.failureKind === failureKind &&
          previous.failureStage === failureStage &&
          Date.now() - Date.parse(previous.timestamp) < 60_000
        )
          return;
        // Re-check the same consent epoch after asynchronous file reads.
        if ((await consentSince(env)) !== since) return;
        await write(env, [
          ...entries,
          {
            id: randomUUID(),
            event,
            timestamp: new Date().toISOString(),
            appVersion: env.appVersion,
            platform: env.platform,
            failureKind,
            failureStage,
          },
        ]);
      }).catch(() => undefined),
    );
  });
