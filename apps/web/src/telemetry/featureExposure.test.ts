import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ capture: vi.fn(async () => true) }));

vi.mock("./runtime", () => ({ telemetry: { capture: harness.capture } }));

import { captureFeatureExposureOnce } from "./featureExposure";

afterEach(() => {
  vi.unstubAllGlobals();
  harness.capture.mockClear();
});

describe("captureFeatureExposureOnce", () => {
  it("deduplicates concurrent and remounted feature exposures for one app session", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    const results = await Promise.all([
      captureFeatureExposureOnce("voice.setup", "setup"),
      captureFeatureExposureOnce("voice.setup", "settings"),
    ]);
    await expect(captureFeatureExposureOnce("voice.setup", "settings")).resolves.toBe(false);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(harness.capture).toHaveBeenCalledOnce();
    expect(harness.capture).toHaveBeenCalledWith({
      event: "feature.exposed",
      properties: {
        feature: "voice.setup",
        feature_area: "Voice",
        feature_label: "Install local voice input",
        surface: "setup",
      },
    });
  });
});
