// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  getProviderSetupCapabilities,
  resolveProviderSetupAction,
  resolveProviderSetupCommand,
} from "./capabilities.ts";
import { resolveProviderSetupExecution } from "./execution.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const linux = { platform: "linux", isWsl: false } as const;

describe("provider setup capability registry", () => {
  it("discovers and runs the Claude executable installed into its configured HOME", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sb-claude-home-install-"));
    try {
      const homePath = join(directory, "account");
      const environment = { PATH: join(directory, "inherited-bin") };
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            enabled: true,
            config: { binaryPath: "claude", homePath },
          },
        },
      });
      const platform = { platform: process.platform, isWsl: false };
      const discover = () =>
        getProviderSetupCapabilities(platform, { settings, environment }).find(
          (entry) => entry.provider === "claude",
        )?.installed;
      const executionFor = (actionId: string) =>
        Effect.runPromise(
          resolveProviderSetupExecution({
            action: resolveProviderSetupAction(actionId, platform)!,
            settings,
            environment,
            codexPaths: {
              codexHome: join(directory, "codex"),
              configPath: "",
              configRoot: directory,
              deniedPaths: [],
            },
          }).pipe(Effect.provide(NodeServices.layer)),
        );
      expect(discover()).toBe(false);
      const install = await executionFor("claude.install");

      // Simulate native installer output using the HOME that the setup job
      // supplies, then exercise discovery, login, and the runtime resolver.
      const nativeBin = join(install.env!.HOME!, ".local", "bin");
      mkdirSync(nativeBin, { recursive: true });
      const executable = join(nativeBin, process.platform === "win32" ? "claude.exe" : "claude");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(discover()).toBe(true);
      const auth = await executionFor("claude.auth.login");
      expect(resolveCommandPath(auth.command, { env: auth.env })).toBe(executable);
      const runtimeEnv = await Effect.runPromise(makeClaudeEnvironment({ homePath }, environment));
      expect(resolveCommandPath("claude", { env: runtimeEnv })).toBe(executable);

      // An explicitly configured executable remains first even when the
      // account home also contains a standalone installation.
      mkdirSync(environment.PATH, { recursive: true });
      const configuredExecutable = join(
        environment.PATH,
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      writeFileSync(configuredExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(resolveCommandPath("claude", { env: runtimeEnv })).toBe(configuredExecutable);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discovers disabled providers and rechecks files installed after the app started", () => {
    const directory = mkdtempSync(join(tmpdir(), "sb-provider-discovery-"));
    try {
      const settings = decodeSettings({});
      const environment = { PATH: directory };
      const discover = () => getProviderSetupCapabilities(linux, { settings, environment });
      expect(discover().map((entry) => entry.installed)).toEqual([false, false]);
      writeFileSync(join(directory, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(settings.providers.claudeAgent.enabled).toBe(false);
      expect(discover().map((entry) => entry.installed)).toEqual([false, true]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the managed Codex installation visible with an instance PATH override", () => {
    const directory = mkdtempSync(join(tmpdir(), "sb-managed-discovery-"));
    try {
      const codexPaths = {
        codexHome: join(directory, "codex-home"),
        configPath: join(directory, "codex-home", "config.toml"),
        configRoot: directory,
        deniedPaths: [],
      };
      const managedBin = join(codexPaths.codexHome, "bin");
      mkdirSync(managedBin, { recursive: true });
      writeFileSync(
        join(managedBin, process.platform === "win32" ? "codex.exe" : "codex"),
        "never execute this discovery fixture",
        { mode: 0o755 },
      );
      const settings = decodeSettings({
        providerInstances: {
          codex: {
            driver: "codex",
            enabled: false,
            config: { binaryPath: "codex" },
            environment: [{ name: "PATH", value: directory, sensitive: false }],
          },
        },
      });
      const platform = { platform: process.platform, isWsl: false };
      const codex = getProviderSetupCapabilities(platform, {
        settings,
        environment: { PATH: managedBin },
        codexPaths,
      }).find((entry) => entry.provider === "codex");
      // Windows uses the upstream per-user standalone location, rather than the managed POSIX bin.
      expect(codex?.installed).toBe(process.platform !== "win32");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("respects the default instance binary and PATH without running it", () => {
    const directory = mkdtempSync(join(tmpdir(), "sb-provider-custom-"));
    try {
      writeFileSync(join(directory, "custom-claude"), "this executable must never be spawned", {
        mode: 0o755,
      });
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            enabled: false,
            config: { binaryPath: "custom-claude" },
            environment: [{ name: "PATH", value: directory, sensitive: false }],
          },
        },
      });
      expect(
        getProviderSetupCapabilities(linux, { settings, environment: { PATH: "/missing" } }).find(
          (entry) => entry.provider === "claude",
        )?.installed,
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
