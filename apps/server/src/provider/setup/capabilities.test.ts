import { describe, expect, it } from "vitest";

import {
  getProviderSetupCapabilities,
  resolveProviderSetupAction,
  resolveProviderSetupCommand,
} from "./capabilities.ts";

const linux = { platform: "linux", isWsl: false } as const;

describe("provider setup capability registry", () => {
  it("exposes only Codex through stable allowlisted action ids", () => {
    const capabilities = getProviderSetupCapabilities(linux);

    expect(capabilities.map((capability) => capability.provider)).toEqual(["codex"]);
    expect(
      capabilities.flatMap((capability) => capability.actions.map((action) => action.id)),
    ).toEqual([
      "codex.install",
      "codex.auth.browser",
      "codex.auth.device-code",
      "codex.auth.api-key",
      "codex.auth.access-token",
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
    expect(resolveProviderSetupAction("claude.auth.login", linux)).toBeNull();
    expect(resolveProviderSetupAction("cursor.auth.login", linux)).toBeNull();
    expect(resolveProviderSetupAction("opencode.auth.login", linux)).toBeNull();
    expect(resolveProviderSetupAction("codex.install; rm -rf /", linux)).toBeNull();
  });

  it("exposes the same Codex-only flow on Linux, native Windows, and WSL", () => {
    for (const platform of [
      { platform: "linux", isWsl: false },
      { platform: "win32", isWsl: false },
      { platform: "linux", isWsl: true },
    ] as const) {
      expect(getProviderSetupCapabilities(platform).map((entry) => entry.provider)).toEqual([
        "codex",
      ]);
      expect(
        getProviderSetupCapabilities(platform)[0]?.actions.every((action) => action.supported),
      ).toBe(true);
    }
  });

  it("uses the official standalone installer on Windows and preserves an explicit Codex binary", () => {
    const windows = { platform: "win32", isWsl: false } as const;
    const install = resolveProviderSetupAction("codex.install", windows);
    const login = resolveProviderSetupAction("codex.auth.browser", windows);
    expect(install).not.toBeNull();
    expect(login).not.toBeNull();
    expect(install).toMatchObject({
      executable: "powershell.exe",
      args: expect.arrayContaining([
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
      ]),
    });
    expect(install?.args.at(-1)).toContain("https://chatgpt.com/codex/install.ps1");
    expect(
      resolveProviderSetupCommand({
        action: install!,
        platform: windows,
        configuredCodexBinary: "codex",
      }),
    ).toBe("powershell.exe");
    expect(
      resolveProviderSetupCommand({
        action: login!,
        platform: windows,
        configuredCodexBinary: "codex",
      }),
    ).toBe("codex");
    expect(
      resolveProviderSetupCommand({
        action: login!,
        platform: windows,
        configuredCodexBinary: "C:\\Tools\\codex.exe",
      }),
    ).toBe("C:\\Tools\\codex.exe");
  });
});
