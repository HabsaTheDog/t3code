import type {
  ProviderSetupAction,
  ProviderSetupCapability,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { providerIsDefault, summarizeProvider, visibleProviderActions } from "./ProviderSetupStep";

const installAction = {
  id: "codex.install",
  kind: "install",
  label: "Install",
  supported: true,
  unsupportedReason: null,
  requiresConfirmation: true,
  secretInput: null,
  interaction: "background",
} satisfies ProviderSetupAction;

const authAction = {
  id: "codex.auth.api-key",
  kind: "authenticate",
  label: "Use API key",
  supported: true,
  unsupportedReason: null,
  requiresConfirmation: false,
  secretInput: "api-key",
  interaction: "background",
} satisfies ProviderSetupAction;

const capability = {
  provider: "codex",
  displayName: "Codex",
  executable: "codex",
  actions: [installAction, authAction],
} satisfies ProviderSetupCapability;

describe("provider setup view model", () => {
  it("offers explicit installation and authentication before probing, then hides reinstall", () => {
    expect(visibleProviderActions(capability, false)).toEqual([installAction, authAction]);
    expect(visibleProviderActions(capability, true)).toEqual([authAction]);
  });

  it("combines status across configured instances of the same driver", () => {
    const providers = [
      {
        driver: "codex",
        installed: true,
        enabled: false,
        version: "1.2.3",
        auth: { status: "unauthenticated" },
      },
      {
        driver: "codex",
        installed: true,
        enabled: true,
        version: "1.2.4",
        auth: { status: "authenticated" },
      },
    ] as unknown as ReadonlyArray<ServerProvider>;

    expect(summarizeProvider(providers, "codex")).toEqual({
      installed: true,
      authenticated: true,
      selected: true,
      version: "1.2.3",
    });
  });

  it("maps the setup Claude name to the claudeAgent runtime driver", () => {
    const providers = [
      {
        instanceId: "configured-claude",
        driver: "claudeAgent",
        installed: true,
        enabled: true,
        version: "2.1.0",
        auth: { status: "authenticated" },
      },
    ] as unknown as ReadonlyArray<ServerProvider>;

    expect(summarizeProvider(providers, "claude")).toMatchObject({
      installed: true,
      authenticated: true,
    });
    expect(providerIsDefault(providers, "claude", new Set(["configured-claude"]))).toBe(true);
  });
});
