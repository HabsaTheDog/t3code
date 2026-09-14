import { describe, expect, it } from "vite-plus/test";
import { classifyTelemetryFailure, healthProperties } from "./telemetryHealth.js";

describe("content-free health diagnostics", () => {
  it.each([
    ["getLocalEnvironmentBootstraps is not a function", "foreign_backend"],
    ["EADDRINUSE 127.0.0.1:3773", "port_collision"],
    ["EACCES C:\\Users\\private\\secret", "permission"],
    ["Der Zugriff auf den Pfad wurde verweigert", "permission"],
    ["SHA256 checksum mismatch", "checksum"],
    ["ETIMEDOUT", "timeout"],
    ["process exited with code 1", "process_exit"],
    ["Bearer super-secret-token", "unknown"],
  ])("classifies %s without retaining its text", (message, expected) => {
    expect(classifyTelemetryFailure(new Error(message))).toBe(expected);
  });
  it("drops arbitrary fields and invalid categorical values", () => {
    expect(
      healthProperties({
        failure_kind: "permission",
        failure_stage: "install",
        message: "private transcript",
        stderr: "secret",
        platform: "username",
        action: "curl secret",
        provider: "codex",
        failure_app_version: "0.2.3-alpha.1",
        duration_ms: -5,
        queued_items: Infinity,
        recovered: true,
      }),
    ).toEqual({
      failure_kind: "permission",
      failure_stage: "install",
      provider: "codex",
      failure_app_version: "0.2.3-alpha.1",
      duration_ms: 0,
      recovered: true,
    });
  });
});
