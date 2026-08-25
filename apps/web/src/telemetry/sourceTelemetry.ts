import type {
  StudyBuddySourceBlock,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
} from "@t3tools/contracts";

const SAFE_EMAIL_PROVIDERS = new Set([
  "google-workspace",
  "microsoft-365",
  "roundcube",
  "sogo",
  "standard-imaps",
]);

export type SafeEmailProvider =
  | "google-workspace"
  | "microsoft-365"
  | "roundcube"
  | "sogo"
  | "standard-imaps"
  | "other";

export function sourceTelemetryProperties(
  source: StudyBuddySourceBlock,
  inventory: Pick<StudyBuddySourceInventory, "connections">,
): Readonly<Record<string, unknown>> {
  const connection = inventory.connections.find(
    (candidate) => candidate.id === source.connectionId,
  );
  return {
    source_kind: source.kind,
    source_enabled: source.enabled,
    ...(source.kind === "email" ? { email_provider: safeEmailProvider(connection) } : {}),
  };
}

export function safeEmailProvider(
  connection: StudyBuddySourceConnection | undefined,
): SafeEmailProvider {
  const candidate = connection?.emailProviderProfile?.id ?? connection?.adapterId ?? "";
  return SAFE_EMAIL_PROVIDERS.has(candidate)
    ? (candidate as Exclude<SafeEmailProvider, "other">)
    : "other";
}

export function telemetryCountBucket(value: number): "0" | "1" | "2-5" | "6-10" | "11-25" | "26+" {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value === 1) return "1";
  if (value <= 5) return "2-5";
  if (value <= 10) return "6-10";
  if (value <= 25) return "11-25";
  return "26+";
}
