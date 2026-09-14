import type { DesktopBridge } from "@t3tools/contracts";
import type { TelemetryController } from "./controller";

/** Transfer durable native diagnostics only after the analytics outbox accepts them. */
export async function drainDesktopHealth(
  telemetry: Pick<TelemetryController, "capture">,
  bridge: Pick<DesktopBridge, "getHealthEvents" | "acknowledgeHealthEvents"> | undefined,
): Promise<void> {
  if (!bridge?.getHealthEvents || !bridge.acknowledgeHealthEvents) return;
  try {
    const entries = await bridge.getHealthEvents();
    const accepted: string[] = [];
    for (const entry of entries) {
      if (
        await telemetry.capture({
          eventId: entry.id,
          event: entry.event,
          timestamp: entry.timestamp,
          idempotencyKey: `desktop-health:${entry.id}`,
          properties: {
            failure_kind: entry.failureKind,
            failure_stage: entry.failureStage,
            failure_app_version: entry.appVersion,
            platform: entry.platform,
            recovered: true,
          },
        })
      )
        accepted.push(entry.id);
    }
    if (accepted.length) await bridge.acknowledgeHealthEvents(accepted);
  } catch {
    /* A diagnostic failure must never break startup. */
  }
}
