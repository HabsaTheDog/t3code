import { APP_VERSION, HOSTED_APP_CHANNEL } from "../branding";

export const TELEMETRY_SCHEMA_VERSION = 7;

export function telemetryContextProperties(): Readonly<Record<string, unknown>> {
  const clientType = typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web";
  return {
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    app_version: APP_VERSION,
    client_type: clientType,
    release_channel: HOSTED_APP_CHANNEL ?? (import.meta.env.DEV ? "dev" : "alpha"),
  };
}
