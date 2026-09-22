import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { isProviderDriverAvailable } from "./providerAvailability";

it("makes the three supported providers selectable in settings and chat", () => {
  for (const driver of ["codex", "claudeAgent", "antigravity"]) {
    expect(isProviderDriverAvailable(ProviderDriverKind.make(driver))).toBe(true);
  }
  expect(isProviderDriverAvailable(ProviderDriverKind.make("unregistered"))).toBe(false);
});
