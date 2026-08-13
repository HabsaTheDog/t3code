import "../../index.css";

import type { DesktopSpeechModelState } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  state: {
    status: "not-enabled",
    model: "parakeet-tdt-0.6b-v3-int8",
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  } as DesktopSpeechModelState,
  enable: vi.fn(),
  remove: vi.fn(),
  capture: vi.fn(async () => true),
  expose: vi.fn(async () => true),
}));

vi.mock("~/lib/desktopSpeechReactQuery", () => ({
  useDesktopSpeechState: () => ({ data: harness.state }),
  useDesktopSpeechActions: () => ({ enable: harness.enable, remove: harness.remove }),
}));
vi.mock("~/telemetry/featureExposure", () => ({
  captureFeatureExposureOnce: harness.expose,
}));
vi.mock("~/telemetry/runtime", () => ({ telemetry: { capture: harness.capture } }));

import { SpeechModelCard } from "./SpeechModelCard";

describe("SpeechModelCard telemetry", () => {
  beforeEach(() => {
    harness.state = {
      status: "not-enabled",
      model: "parakeet-tdt-0.6b-v3-int8",
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    };
    harness.enable.mockReset().mockResolvedValue({ ...harness.state, status: "downloading" });
    harness.remove.mockReset().mockResolvedValue({ ...harness.state, status: "not-enabled" });
    harness.capture.mockClear();
    harness.expose.mockClear();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {},
    });
  });

  it("tracks a voice model download without user or filesystem data", async () => {
    await render(<SpeechModelCard surface="setup" />);
    await page.getByRole("button", { name: "Download voice input" }).click();

    expect(harness.enable).toHaveBeenCalledOnce();
    expect(harness.expose).toHaveBeenCalledWith("voice.setup", "setup");
    expect(harness.capture).toHaveBeenCalledWith({
      event: "speech.model.install_started",
      properties: { surface: "setup" },
    });
    expect(harness.capture).toHaveBeenCalledWith({
      event: "feature.used",
      properties: expect.objectContaining({
        feature: "voice.setup",
        action: "enable",
        surface: "setup",
      }),
    });
  });

  it("tracks an installer transition with only a bounded failure category", async () => {
    harness.state = { ...harness.state, status: "downloading" };
    const view = await render(<SpeechModelCard surface="settings" />);
    harness.state = {
      ...harness.state,
      status: "error",
      error: "Download failed for /home/alvaro/private-model at https://secret.example",
    };
    await view.rerender(<SpeechModelCard surface="settings" />);

    expect(harness.capture).toHaveBeenCalledWith({
      event: "speech.model.install_failed",
      properties: {
        surface: "settings",
        failure_kind: "download_failed",
        failure_stage: "downloading",
      },
    });
    expect(JSON.stringify(harness.capture.mock.calls)).not.toContain("/home/alvaro");
    expect(JSON.stringify(harness.capture.mock.calls)).not.toContain("secret.example");
  });

  it("does not report exposure when voice input is unavailable", async () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: undefined,
    });

    await render(<SpeechModelCard surface="settings" />);

    await expect
      .element(page.getByText("Voice input is available in the Study Buddy desktop app."))
      .toBeVisible();
    expect(harness.expose).not.toHaveBeenCalled();
    expect(harness.capture).not.toHaveBeenCalled();
  });
});
