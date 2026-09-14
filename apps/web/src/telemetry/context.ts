import { APP_VERSION, HOSTED_APP_CHANNEL } from "../branding";

export const TELEMETRY_SCHEMA_VERSION = 8;

export function telemetryContextProperties(): Readonly<Record<string, unknown>> {
  const clientType = typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web";
  return {
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    app_version: APP_VERSION,
    client_type: clientType,
    platform:
      typeof navigator === "undefined"
        ? "unknown"
        : /win/i.test(navigator.platform)
          ? "win32"
          : /mac/i.test(navigator.platform)
            ? "darwin"
            : /linux/i.test(navigator.platform)
              ? "linux"
              : "web",
    release_channel:
      HOSTED_APP_CHANNEL ??
      (import.meta.env.DEV
        ? "dev"
        : /nightly/i.test(APP_VERSION)
          ? "nightly"
          : /alpha/i.test(APP_VERSION)
            ? "alpha"
            : /beta/i.test(APP_VERSION)
              ? "beta"
              : "stable"),
  };
}
