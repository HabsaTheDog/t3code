import { describe, expect, it } from "vitest";

import {
  getProviderSetupCapabilities,
  resolveProviderSetupAction,
  resolveProviderSetupCommand,
} from "./capabilities.ts";

const linux = { platform: "linux", isWsl: false } as const;

describe("provider setup capability registry", () => {
  it("exposes Codex and Claude through stable allowlisted action ids", () => {
    const capabilities = getProviderSetupCapabilities(linux);

    expect(capabilities.map((capability) => capability.provider)).toEqual(["codex", "claude"]);
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
    ]);
    expect(capabilities).not.toHaveProperty("command");
    expect(JSON.stringify(capabilities)).not.toContain("@openai/codex");
    expect(JSON.stringify(capabilities)).not.toContain("curl https://cursor.com/install");
  });

  it("resolves only fixed commands owned by the backend registry", () => {
    expect(resolveProviderSetupAction("codex.install", linux)).toMatchObject({
      executable: "sh",
      args: ["-lc", expect.stringContaining("https://chatgpt.com/codex/install.sh")],
      requiresConfirmation: true,
    });
    expect(resolveProviderSetupAction("codex.install", linux)?.args.at(-1)).toContain(
      "CODEX_NON_INTERACTIVE=1",
    );
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
    expect(resolveProviderSetupAction("cursor.auth.login", linux)).toBeNull();
    expect(resolveProviderSetupAction("opencode.auth.login", linux)).toBeNull();
    expect(resolveProviderSetupAction("codex.install; rm -rf /", linux)).toBeNull();
  });

  it("exposes the same Codex and Claude flows on Linux, native Windows, and WSL", () => {
    for (const platform of [
      { platform: "linux", isWsl: false },
      { platform: "win32", isWsl: false },
      { platform: "linux", isWsl: true },
    ] as const) {
      expect(getProviderSetupCapabilities(platform).map((entry) => entry.provider)).toEqual([
        "codex",
        "claude",
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
      args: expect.arrayContaining(["-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]),
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

it("bootstraps Claude without npm on Linux and Windows and respects its configured binary", () => {
  const action = resolveProviderSetupAction("claude.install", linux)!;
  expect(action.executable).toBe("bash");
  expect(action.args.join(" ")).toContain("https://claude.ai/install.sh");
  expect(
    resolveProviderSetupAction("claude.install", { platform: "win32", isWsl: false })?.args.join(
      " ",
    ),
  ).toContain("https://claude.ai/install.ps1");
  expect(
    resolveProviderSetupCommand({
      action: resolveProviderSetupAction("claude.auth.login", linux)!,
      platform: linux,
      configuredCodexBinary: "codex",
      configuredClaudeBinary: "/configured/claude",
    }),
  ).toBe("/configured/claude");
});
