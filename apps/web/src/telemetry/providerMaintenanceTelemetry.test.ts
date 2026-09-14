import { describe, expect, it } from "vite-plus/test";
import { providerMaintenanceEvent } from "./providerMaintenanceTelemetry";

describe("provider maintenance telemetry", () => {
  const state = {
    status: "succeeded" as const,
    startedAt: null,
    finishedAt: null,
    message: null,
    output: null,
  };
  it("reports success only after version verification", () => {
    expect(providerMaintenanceEvent("codex", state, 100)).toMatchObject({
      event: "provider.update_completed",
      properties: { outcome: "completed", duration_ms: 100 },
    });
    expect(providerMaintenanceEvent("codex", { ...state, status: "unchanged" }, 100)).toMatchObject(
      {
        event: "provider.update_failed",
        properties: { outcome: "unchanged", failure_kind: "verification" },
      },
    );
    expect(providerMaintenanceEvent("codex", undefined, 100).event).toBe(
      "provider.update_unverified",
    );
  });
  it("classifies private installer output locally without retaining it", () => {
    const event = providerMaintenanceEvent(
      "codex",
      {
        ...state,
        status: "failed",
        output: "EACCES C:\\Users\\PRIVATE sk-proj-SECRET",
        message: "exited with code 1",
      },
      20,
    );
    expect(event.properties?.failure_kind).toBe("permission");
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|SECRET|Users/);
  });
});
