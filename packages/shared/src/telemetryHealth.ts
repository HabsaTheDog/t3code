/** Only the category leaves the process; never return the inspected error text. */
export function classifyTelemetryFailure(error: unknown): string {
  const text = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).slice(0, 16_384);
  if (/version mismatch|foreign backend|getLocalEnvironmentBootstraps.*not a function/i.test(text))
    return "foreign_backend";
  if (/EADDRINUSE|address already in use|port.*unavailable/i.test(text)) return "port_collision";
  if (/checksum|sha256|digest|signature|prüfsumme/i.test(text)) return "checksum";
  if (
    /EACCES|EPERM|access.*denied|permission|not permitted|unauthorizedaccess|zugriff.*verweigert|HTTP.?403|forbidden/i.test(
      text,
    )
  )
    return "permission";
  if (/junction|reparse|non-empty directory|install layout/i.test(text)) return "install_layout";
  if (/ENOSPC|disk.*full|not enough space|nicht genügend speicherplatz/i.test(text))
    return "disk_full";
  if (/architecture|unsupported platform/i.test(text)) return "architecture";
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/HTTP.?429|rate.?limit/i.test(text)) return "rate_limit";
  if (/ENOTFOUND|ECONN|ENET|fetch|network|TLS|certificate|HTTP.?5\d\d|download/i.test(text))
    return "network";
  if (/ENOENT|not found|not recognized|nicht gefunden|nicht.*erkannt/i.test(text))
    return "missing_dependency";
  if (/exited with code|process.*exit|spawn/i.test(text)) return "process_exit";
  return "unknown";
}

export const TELEMETRY_CONSENT_VERSION = 1;
export const HEALTH_FAILURE_KINDS = new Set([
  "foreign_backend",
  "port_collision",
  "checksum",
  "permission",
  "install_layout",
  "disk_full",
  "architecture",
  "timeout",
  "rate_limit",
  "network",
  "missing_dependency",
  "process_exit",
  "unknown",
  "verification",
]);

/** Health events have a closed, content-free property schema. */
export function healthProperties(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const enums: Record<string, ReadonlySet<string>> = {
    failure_kind: HEALTH_FAILURE_KINDS,
    failure_stage: new Set([
      "startup",
      "renderer",
      "backend",
      "check",
      "download",
      "install",
      "authenticate",
      "unknown",
    ]),
    outcome: new Set([
      "completed",
      "failed",
      "cancelled",
      "start_failed",
      "stored_secret",
      "unchanged",
      "unverified",
    ]),
    provider: new Set(["codex", "claude", "cursor", "opencode"]),
    action: new Set([
      "codex.install",
      "codex.auth.browser",
      "codex.auth.device-code",
      "codex.auth.api-key",
      "codex.auth.access-token",
      "claude.install",
      "claude.auth.login",
      "claude.auth.console",
      "claude.auth.api-key",
      "cursor.install",
      "cursor.auth.login",
      "opencode.install",
      "opencode.auth.login",
    ]),
    platform: new Set(["win32", "linux", "darwin", "web", "unknown"]),
    runtime_arch: new Set(["x64", "arm64", "other"]),
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (typeof input[key] === "string" && allowed.has(input[key])) result[key] = input[key];
  }
  for (const key of [
    "duration_ms",
    "exit_code",
    "queued_items",
    "dropped_count",
    "oldest_age_ms",
  ]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = Math.max(
        key === "exit_code" ? -1 : 0,
        Math.min(2_147_483_647, Math.round(value)),
      );
  }
  if (typeof input.recovered === "boolean") result.recovered = input.recovered;
  if (
    typeof input.failure_app_version === "string" &&
    /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(input.failure_app_version)
  )
    result.failure_app_version = input.failure_app_version.slice(0, 80);
  return result;
}
