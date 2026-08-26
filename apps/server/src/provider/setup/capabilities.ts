import type {
  ProviderSetupActionCapability,
  ProviderSetupActionId,
  ProviderSetupCapability,
  ProviderSetupPlatform,
  ProviderSetupProvider,
} from "./types.ts";

interface ProviderSetupActionDefinition {
  readonly id: ProviderSetupActionId;
  readonly provider: ProviderSetupProvider;
  readonly kind: ProviderSetupActionCapability["kind"];
  readonly label: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly requiresConfirmation: boolean;
  readonly secretInput: ProviderSetupActionCapability["secretInput"];
  readonly interaction: ProviderSetupActionCapability["interaction"];
  readonly supports: (platform: ProviderSetupPlatform) => string | null;
}

export interface ResolvedProviderSetupAction {
  readonly id: ProviderSetupActionId;
  readonly provider: ProviderSetupProvider;
  readonly kind: ProviderSetupActionCapability["kind"];
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly requiresConfirmation: boolean;
  readonly secretInput: ProviderSetupActionCapability["secretInput"];
  readonly interaction: ProviderSetupActionCapability["interaction"];
  readonly unsupportedReason: string | null;
}

export function resolveProviderSetupCommand(input: {
  readonly action: ResolvedProviderSetupAction;
  readonly platform: ProviderSetupPlatform;
  readonly configuredCodexBinary: string;
}): string {
  if (input.action.provider === "codex" && input.action.kind !== "install") {
    return input.configuredCodexBinary;
  }
  return input.action.executable;
}

const supportedEverywhere = () => null;

const WINDOWS_CODEX_INSTALL_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$env:CODEX_NON_INTERACTIVE = '1'",
  "Invoke-RestMethod 'https://chatgpt.com/codex/install.ps1' | Invoke-Expression",
].join("; ");

// The desktop app must be able to bootstrap Codex on a clean machine. The
// official standalone installer does not require a pre-existing Node/npm
// toolchain and verifies the downloaded Codex release before installing it.
const POSIX_CODEX_INSTALL_SCRIPT =
  "curl -fsSL --proto '=https' --tlsv1.2 https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh";

const supportsCursor = (platform: ProviderSetupPlatform): string | null => {
  if (platform.platform === "darwin" || platform.platform === "linux") {
    return null;
  }
  if (platform.platform === "win32") {
    return "Cursor CLI is not supported in native Windows shells. Install WSL, open Study Buddy inside that Linux environment, then retry.";
  }
  return "Cursor CLI installation is supported on macOS, Linux, and Windows through WSL.";
};

const ACTIONS: ReadonlyArray<ProviderSetupActionDefinition> = [
  {
    id: "codex.install",
    provider: "codex",
    kind: "install",
    label: "Install Codex",
    executable: "sh",
    args: ["-lc", POSIX_CODEX_INSTALL_SCRIPT],
    requiresConfirmation: true,
    secretInput: null,
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "codex.auth.browser",
    provider: "codex",
    kind: "authenticate",
    label: "Sign in with browser",
    executable: "codex",
    args: ["login"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportedEverywhere,
  },
  {
    id: "codex.auth.device-code",
    provider: "codex",
    kind: "authenticate",
    label: "Sign in with device code",
    executable: "codex",
    args: ["login", "--device-auth"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportedEverywhere,
  },
  {
    id: "codex.auth.api-key",
    provider: "codex",
    kind: "authenticate",
    label: "Sign in with API key",
    executable: "codex",
    args: ["login", "--with-api-key"],
    requiresConfirmation: false,
    secretInput: "api-key",
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "codex.auth.access-token",
    provider: "codex",
    kind: "authenticate",
    label: "Sign in with access token",
    executable: "codex",
    args: ["login", "--with-access-token"],
    requiresConfirmation: false,
    secretInput: "access-token",
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "claude.install",
    provider: "claude",
    kind: "install",
    label: "Install Claude Code",
    executable: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
    requiresConfirmation: true,
    secretInput: null,
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "claude.auth.login",
    provider: "claude",
    kind: "authenticate",
    label: "Sign in to Claude",
    executable: "claude",
    args: ["auth", "login"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportedEverywhere,
  },
  {
    id: "claude.auth.console",
    provider: "claude",
    kind: "authenticate",
    label: "Sign in with Console",
    executable: "claude",
    args: ["auth", "login", "--console"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportedEverywhere,
  },
  {
    id: "claude.auth.api-key",
    provider: "claude",
    kind: "authenticate",
    label: "Sign in with API key",
    executable: "claude",
    args: ["auth", "status"],
    requiresConfirmation: false,
    secretInput: "api-key",
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "cursor.install",
    provider: "cursor",
    kind: "install",
    label: "Install Cursor CLI",
    executable: "bash",
    // This fixed string is the official installer invocation. Client input is
    // never interpolated into it.
    args: ["-lc", "curl https://cursor.com/install -fsS | bash"],
    requiresConfirmation: true,
    secretInput: null,
    interaction: "background",
    supports: supportsCursor,
  },
  {
    id: "cursor.auth.login",
    provider: "cursor",
    kind: "authenticate",
    label: "Sign in to Cursor",
    executable: "cursor-agent",
    args: ["login"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportsCursor,
  },
  {
    id: "opencode.install",
    provider: "opencode",
    kind: "install",
    label: "Install OpenCode",
    executable: "npm",
    args: ["install", "-g", "opencode-ai"],
    requiresConfirmation: true,
    secretInput: null,
    interaction: "background",
    supports: supportedEverywhere,
  },
  {
    id: "opencode.auth.login",
    provider: "opencode",
    kind: "authenticate",
    label: "Sign in to OpenCode",
    executable: "opencode",
    args: ["auth", "login"],
    requiresConfirmation: false,
    secretInput: null,
    interaction: "sanitized-terminal",
    supports: supportedEverywhere,
  },
];

const ACTIONS_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

const PROVIDERS: ReadonlyArray<{
  readonly provider: ProviderSetupProvider;
  readonly displayName: string;
  readonly executable: string;
}> = [
  { provider: "codex", displayName: "Codex", executable: "codex" },
  { provider: "claude", displayName: "Claude", executable: "claude" },
  { provider: "cursor", displayName: "Cursor", executable: "cursor-agent" },
  { provider: "opencode", displayName: "OpenCode", executable: "opencode" },
];

export function detectProviderSetupPlatform(input?: {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): ProviderSetupPlatform {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  return {
    platform,
    isWsl:
      platform === "linux" &&
      (typeof env.WSL_DISTRO_NAME === "string" || typeof env.WSL_INTEROP === "string"),
  };
}

export function resolveProviderSetupAction(
  actionId: string,
  platform: ProviderSetupPlatform,
): ResolvedProviderSetupAction | null {
  const definition = ACTIONS_BY_ID.get(actionId as ProviderSetupActionId);
  if (!definition || definition.provider !== "codex") {
    return null;
  }
  const windowsStandaloneInstall =
    definition.id === "codex.install" && platform.platform === "win32";
  return {
    id: definition.id,
    provider: definition.provider,
    kind: definition.kind,
    executable: windowsStandaloneInstall ? "powershell.exe" : definition.executable,
    args: windowsStandaloneInstall
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_CODEX_INSTALL_SCRIPT,
        ]
      : [...definition.args],
    requiresConfirmation: definition.requiresConfirmation,
    secretInput: definition.secretInput,
    interaction: definition.interaction,
    unsupportedReason: definition.supports(platform),
  };
}

export function getProviderSetupCapabilities(
  platform: ProviderSetupPlatform = detectProviderSetupPlatform(),
): ReadonlyArray<ProviderSetupCapability> {
  return PROVIDERS.filter((provider) => provider.provider === "codex").map((provider) => ({
    ...provider,
    actions: ACTIONS.filter((action) => action.provider === provider.provider).map((action) => {
      const unsupportedReason = action.supports(platform);
      return {
        id: action.id,
        kind: action.kind,
        label: action.label,
        supported: unsupportedReason === null,
        unsupportedReason,
        requiresConfirmation: action.requiresConfirmation,
        secretInput: action.secretInput,
        interaction: action.interaction,
      };
    }),
  }));
}
