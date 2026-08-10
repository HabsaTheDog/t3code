import { TelemetryController } from "./controller";
import { persistClientSettingsDurably } from "../hooks/useSettings";
import { telemetryContextProperties } from "./context";

const projectToken = (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined)?.trim();
const knownConfiguredSecrets = new Set<string>();

export const telemetry = new TelemetryController({
  ...(projectToken ? { projectToken } : {}),
  contextProperties: telemetryContextProperties,
  configuredSecrets: () => [...knownConfiguredSecrets],
  onInstallationIdCreated: async (installationId) => {
    await persistClientSettingsDurably({ installationId });
  },
});

export const telemetryProductionConfigured = Boolean(projectToken);

/** Keeps write-only secrets available for deterministic redaction in this process only. */
export function registerTelemetrySecret(value: string): void {
  const secret = value.trim();
  if (secret.length >= 4) knownConfiguredSecrets.add(secret);
}
