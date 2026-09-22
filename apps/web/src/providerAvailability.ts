import { ProviderDriverKind } from "@t3tools/contracts";

export const AVAILABLE_PROVIDER_DRIVERS = new Set<ProviderDriverKind>(
  ["codex", "claudeAgent", "antigravity"].map((driver) => ProviderDriverKind.make(driver)),
);

export function isProviderDriverAvailable(driver: ProviderDriverKind): boolean {
  return AVAILABLE_PROVIDER_DRIVERS.has(driver);
}
