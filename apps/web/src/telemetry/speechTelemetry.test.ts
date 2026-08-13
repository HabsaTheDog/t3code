import { describe, expect, it } from "vite-plus/test";

import {
  classifySpeechFailure,
  classifySpeechModelFailure,
  safeSpeechDuration,
} from "./speechTelemetry";

describe("speech telemetry", () => {
  it("maps private runtime errors to bounded categories", () => {
    const privateError = new DOMException(
      "User denied microphone permission for USB Mic",
      "NotAllowedError",
    );
    expect(classifySpeechFailure(privateError)).toBe("permission_denied");
    expect(classifySpeechFailure(new Error("No speech was detected in /tmp/private.wav"))).toBe(
      "no_speech",
    );
    expect(JSON.stringify([classifySpeechFailure(privateError)])).not.toContain("USB Mic");
    expect(JSON.stringify([classifySpeechFailure(privateError)])).not.toContain("/tmp");
  });

  it("maps installer failures without retaining URLs or filesystem details", () => {
    expect(classifySpeechModelFailure("Model download failed (503) at https://private.test")).toBe(
      "download_failed",
    );
    expect(classifySpeechModelFailure("The downloaded archive failed its integrity check")).toBe(
      "integrity_failed",
    );
  });

  it("bounds voice durations to the supported recording limit", () => {
    expect(safeSpeechDuration(12_345.4)).toBe(12_345);
    expect(safeSpeechDuration(Number.NaN)).toBe(0);
    expect(safeSpeechDuration(999_999)).toBe(180_000);
  });
});
