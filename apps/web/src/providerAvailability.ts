import { ProviderDriverKind } from "@t3tools/contracts";

export const AVAILABLE_PROVIDER_DRIVER = ProviderDriverKind.make("codex");

export function isProviderDriverAvailable(driver: ProviderDriverKind): boolean {
  return driver === AVAILABLE_PROVIDER_DRIVER;
}
