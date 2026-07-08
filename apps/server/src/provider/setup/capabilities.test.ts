import { describe, expect, it } from "vitest";

import { getProviderSetupCapabilities, resolveProviderSetupAction } from "./capabilities.ts";

const linux = { platform: "linux", isWsl: false } as const;

describe("provider setup capability registry", () => {
  it("exposes every supported provider through stable allowlisted action ids", () => {
    const capabilities = getProviderSetupCapabilities(linux);

    expect(capabilities.map((capability) => capability.provider)).toEqual([
      "codex",
      "claude",
      "cursor",
      "opencode",
    ]);
    expect(
      capabilities.flatMap((capability) => capability.actions.map((action) => action.id)),
    ).toEqual([
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
    ]);
    expect(capabilities).not.toHaveProperty("command");
    expect(JSON.stringify(capabilities)).not.toContain("@openai/codex");
    expect(JSON.stringify(capabilities)).not.toContain("curl https://cursor.com/install");
  });

  it("resolves only fixed commands owned by the backend registry", () => {
    expect(resolveProviderSetupAction("codex.install", linux)).toMatchObject({
      executable: "npm",
      args: ["install", "-g", "@openai/codex"],
      requiresConfirmation: true,
    });
    expect(resolveProviderSetupAction("codex.auth.browser", linux)).toMatchObject({
      executable: "codex",
      args: ["login"],
    });
    expect(resolveProviderSetupAction("codex.auth.device-code", linux)).toMatchObject({
      executable: "codex",
      args: ["login", "--device-auth"],
    });
    expect(resolveProviderSetupAction("codex.auth.api-key", linux)).toMatchObject({
      executable: "codex",
      args: ["login", "--with-api-key"],
      secretInput: "api-key",
    });
    expect(resolveProviderSetupAction("codex.auth.access-token", linux)).toMatchObject({
      executable: "codex",
      args: ["login", "--with-access-token"],
      secretInput: "access-token",
    });
    expect(resolveProviderSetupAction("claude.auth.login", linux)).toMatchObject({
      executable: "claude",
      args: ["auth", "login"],
    });
    expect(resolveProviderSetupAction("claude.auth.console", linux)).toMatchObject({
      executable: "claude",
      args: ["auth", "login", "--console"],
    });
    expect(resolveProviderSetupAction("claude.auth.api-key", linux)).toMatchObject({
      executable: "claude",
      args: ["auth", "status"],
      secretInput: "api-key",
    });
    expect(resolveProviderSetupAction("cursor.auth.login", linux)).toMatchObject({
      executable: "cursor-agent",
      args: ["login"],
    });
    expect(resolveProviderSetupAction("opencode.install", linux)).toMatchObject({
      executable: "npm",
      args: ["install", "-g", "opencode-ai"],
    });
    expect(resolveProviderSetupAction("opencode.auth.login", linux)).toMatchObject({
      executable: "opencode",
      args: ["auth", "login"],
    });
    expect(resolveProviderSetupAction("codex.install; rm -rf /", linux)).toBeNull();
  });

  it("keeps Cursor unsupported on native Windows and supported on WSL", () => {
    const windowsCursor = getProviderSetupCapabilities({
      platform: "win32",
      isWsl: false,
    }).find((capability) => capability.provider === "cursor");
    const wslCursor = getProviderSetupCapabilities({
      platform: "linux",
      isWsl: true,
    }).find((capability) => capability.provider === "cursor");

    expect(windowsCursor?.actions.every((action) => !action.supported)).toBe(true);
    expect(windowsCursor?.actions[0]?.unsupportedReason).toContain("Install WSL");
    expect(wslCursor?.actions.every((action) => action.supported)).toBe(true);
  });
});
