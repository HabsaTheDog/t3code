import type {
  ProviderSetupAction,
  ProviderSetupActionId,
  ProviderSetupCapability,
  ProviderSetupJobEvent,
  ProviderSetupProvider,
  ProviderSetupStartInput,
} from "@t3tools/contracts";

export type {
  ProviderSetupAction,
  ProviderSetupActionId,
  ProviderSetupCapability,
  ProviderSetupJobEvent,
  ProviderSetupProvider,
};

export type ProviderSetupActionCapability = ProviderSetupAction;
export type ProviderSetupJobRequest = Omit<ProviderSetupStartInput, "actionId"> & {
  /**
   * The RPC schema narrows this to ProviderSetupActionId. Keeping the internal
   * boundary as string preserves defense in depth for non-RPC callers.
   */
  readonly actionId: string;
};

export interface ProviderSetupPlatform {
  readonly platform: NodeJS.Platform;
  readonly isWsl: boolean;
}

export type ProviderSetupTerminalEvent = Extract<
  ProviderSetupJobEvent,
  { readonly type: "completed" | "failed" | "cancelled" }
>;

export interface ProviderSetupJobHandle {
  readonly jobId: string;
  readonly events: AsyncIterable<ProviderSetupJobEvent>;
  readonly completion: Promise<ProviderSetupTerminalEvent>;
  /**
   * Used by a sanitized embedded terminal for interactive login prompts.
   * Input is write-only and is never represented in job events.
   */
  readonly writeInput: (input: string) => Promise<boolean>;
  readonly cancel: () => boolean;
}

export interface ProviderSetupSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly pty?: boolean | undefined;
}

export interface ProviderSetupProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ProviderSetupChildProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly writeStdin: (input: string) => Promise<void>;
  readonly closeStdin: () => void;
  readonly wait: () => Promise<ProviderSetupProcessResult>;
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => void;
}

export interface ProviderSetupProcessSpawner {
  readonly spawn: (input: ProviderSetupSpawnInput) => Promise<ProviderSetupChildProcess>;
}
