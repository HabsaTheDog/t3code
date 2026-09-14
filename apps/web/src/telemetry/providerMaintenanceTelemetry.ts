import type { ServerProviderUpdateState } from "@t3tools/contracts";
import { classifyTelemetryFailure } from "@t3tools/shared/telemetryHealth";
import type { SemanticTelemetryEvent } from "./types";

export function providerMaintenanceEvent(
  provider: string,
  state: ServerProviderUpdateState | undefined,
  durationMs: number,
): SemanticTelemetryEvent {
  const succeeded = state?.status === "succeeded";
  const failed = state?.status === "failed" || state?.status === "unchanged";
  return {
    event: succeeded
      ? "provider.update_completed"
      : failed
        ? "provider.update_failed"
        : "provider.update_unverified",
    properties: {
      provider: provider === "claudeAgent" ? "claude" : provider,
      outcome: succeeded
        ? "completed"
        : state?.status === "unchanged"
          ? "unchanged"
          : failed
            ? "failed"
            : "unverified",
      duration_ms: durationMs,
      failure_stage: "install",
      ...(failed
        ? {
            failure_kind:
              state?.status === "unchanged"
                ? "verification"
                : classifyTelemetryFailure(`${state?.message ?? ""} ${state?.output ?? ""}`),
          }
        : {}),
    },
  };
}
