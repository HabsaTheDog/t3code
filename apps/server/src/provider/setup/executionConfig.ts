import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type UnifiedSettings,
} from "@t3tools/contracts";

import type { ProviderSetupProvider } from "./types.ts";

export function resolveDefaultProviderSetupConfig(
  provider: ProviderSetupProvider,
  settings: Pick<UnifiedSettings, "providers" | "providerInstances">,
) {
  const driver = provider === "claude" ? "claudeAgent" : "codex";
  const instance =
    settings.providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(driver))];
  const config = instance?.config as { readonly binaryPath?: unknown } | undefined;
  const binaryPath =
    typeof config?.binaryPath === "string" && config.binaryPath.trim()
      ? config.binaryPath
      : settings.providers[driver].binaryPath;
  return { instance, binaryPath, config: instance?.config ?? settings.providers[driver] };
}
