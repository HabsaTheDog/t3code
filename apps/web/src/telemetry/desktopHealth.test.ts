import { describe, expect, it, vi } from "vite-plus/test";
import { drainDesktopHealth } from "./desktopHealth";

describe("native health transfer", () => {
  const entry = {
    id: "00000000-0000-4000-8000-000000000001",
    event: "desktop.update_failed" as const,
    timestamp: "2026-09-14T08:00:00.000Z",
    appVersion: "0.2.3-alpha",
    platform: "win32",
    failureKind: "permission",
    failureStage: "download",
  };
  it("acks only durable captures and preserves original UUID, timestamp and version", async () => {
    const capture = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const bridge = {
      getHealthEvents: vi.fn(async () => [entry]),
      acknowledgeHealthEvents: vi.fn(async () => {}),
    };
    await drainDesktopHealth({ capture }, bridge);
    expect(bridge.acknowledgeHealthEvents).not.toHaveBeenCalled();
    await drainDesktopHealth({ capture }, bridge);
    expect(bridge.acknowledgeHealthEvents).toHaveBeenCalledWith([entry.id]);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: entry.id,
        timestamp: entry.timestamp,
        properties: expect.objectContaining({ failure_app_version: entry.appVersion }),
      }),
    );
  });
  it("does not break startup when an older bridge or failed IPC cannot provide diagnostics", async () => {
    const capture = vi.fn();
    await drainDesktopHealth({ capture }, undefined);
    await drainDesktopHealth(
      { capture },
      {
        getHealthEvents: vi.fn().mockRejectedValue(new Error("offline")),
        acknowledgeHealthEvents: vi.fn(),
      },
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
