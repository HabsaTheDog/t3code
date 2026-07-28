import "../../index.css";

import type {
  ProviderSetupAction,
  ProviderSetupActionId,
  ProviderSetupCapability,
  ProviderSetupJobEvent,
  ProviderSetupProvider,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import { createRef } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const listeners = new Map<string, (event: ProviderSetupJobEvent) => void>();
  let nextJob = 1;

  return {
    capabilities: [] as ProviderSetupCapability[],
    providers: [] as ServerProvider[],
    settings: {
      providers: {},
      providerInstances: {},
    } as Pick<UnifiedSettings, "providers" | "providerInstances">,
    environmentStateById: {},
    listeners,
    capture: vi.fn(async () => undefined),
    registerSecret: vi.fn(),
    updateSettings: vi.fn((patch: Partial<UnifiedSettings>) => {
      harness.settings = {
        ...harness.settings,
        ...patch,
        providers: {
          ...harness.settings.providers,
          ...patch.providers,
        },
        providerInstances: {
          ...harness.settings.providerInstances,
          ...patch.providerInstances,
        },
      };
    }),
    refreshProviders: vi.fn(async () => ({})),
    startProviderSetup: vi.fn(async () => ({ jobId: `job-${nextJob++}` })),
    cancelProviderSetup: vi.fn(async () => ({ canceled: true })),
    writeProviderSetupInput: vi.fn(async () => ({ accepted: true })),
    reset() {
      this.capabilities = [];
      this.providers = [];
      this.settings = { providers: {}, providerInstances: {} } as Pick<
        UnifiedSettings,
        "providers" | "providerInstances"
      >;
      listeners.clear();
      nextJob = 1;
      this.capture.mockClear();
      this.registerSecret.mockClear();
      this.updateSettings.mockClear();
      this.refreshProviders.mockClear();
      this.startProviderSetup.mockClear();
      this.cancelProviderSetup.mockClear();
      this.writeProviderSetupInput.mockClear();
    },
  };
});

vi.mock("~/rpc/serverState", () => ({
  useServerProviders: () => harness.providers,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (state: { environmentStateById: object }) => unknown) =>
    selector({ environmentStateById: harness.environmentStateById }),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    server: {
      getProviderSetupCapabilities: async () => structuredClone(harness.capabilities),
      refreshProviders: harness.refreshProviders,
      startProviderSetup: harness.startProviderSetup,
      cancelProviderSetup: harness.cancelProviderSetup,
      writeProviderSetupInput: harness.writeProviderSetupInput,
      subscribeProviderSetupJob: (
        input: { jobId: string },
        listener: (event: ProviderSetupJobEvent) => void,
      ) => {
        harness.listeners.set(input.jobId, listener);
        return () => harness.listeners.delete(input.jobId);
      },
    },
  }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (
    selector?: (settings: Pick<UnifiedSettings, "providers" | "providerInstances">) => unknown,
  ) => (selector ? selector(harness.settings) : harness.settings),
  useUpdateSettings: () => ({
    updateSettings: harness.updateSettings,
  }),
}));

vi.mock("~/telemetry/runtime", () => ({
  registerTelemetrySecret: harness.registerSecret,
  telemetry: {
    capture: harness.capture,
  },
}));

import { ProviderSetupStep, type ProviderSetupStepHandle } from "../../setup/ProviderSetupStep";

function action(
  input: Partial<ProviderSetupAction> & Pick<ProviderSetupAction, "id" | "kind" | "label">,
): ProviderSetupAction {
  return {
    supported: true,
    unsupportedReason: null,
    requiresConfirmation: false,
    secretInput: null,
    interaction: "background",
    ...input,
  };
}

const codexInstall = action({
  id: "codex.install",
  kind: "install",
  label: "Install Codex",
  requiresConfirmation: true,
});
const codexBrowserAuth = action({
  id: "codex.auth.browser",
  kind: "authenticate",
  label: "Sign in with browser",
  interaction: "sanitized-terminal",
});
const codexAccessToken = action({
  id: "codex.auth.access-token",
  kind: "authenticate",
  label: "Sign in with access token",
  secretInput: "access-token",
});
const claudeAuth = action({
  id: "claude.auth.login",
  kind: "authenticate",
  label: "Sign in to Claude",
  interaction: "sanitized-terminal",
});
const claudeConsoleAuth = action({
  id: "claude.auth.console",
  kind: "authenticate",
  label: "Sign in with Console",
  interaction: "sanitized-terminal",
});
const claudeApiKeyAuth = action({
  id: "claude.auth.api-key",
  kind: "authenticate",
  label: "Sign in with API key",
  secretInput: "api-key",
});
const cursorInstallUnsupported = action({
  id: "cursor.install",
  kind: "install",
  label: "Install Cursor CLI",
  supported: false,
  unsupportedReason: "Cursor setup requires Linux, macOS, or WSL.",
  requiresConfirmation: true,
});
const opencodeAuth = action({
  id: "opencode.auth.login",
  kind: "authenticate",
  label: "Sign in to OpenCode",
  interaction: "sanitized-terminal",
});

function capability(
  provider: ProviderSetupProvider,
  displayName: string,
  actions: ProviderSetupAction[],
): ProviderSetupCapability {
  return {
    provider,
    displayName,
    executable: provider,
    actions,
  };
}

function setCapabilities(): void {
  harness.capabilities = [
    capability("codex", "Codex", [codexInstall, codexBrowserAuth, codexAccessToken]),
    capability("claude", "Claude", [claudeAuth, claudeConsoleAuth, claudeApiKeyAuth]),
    capability("cursor", "Cursor", [cursorInstallUnsupported]),
    capability("opencode", "OpenCode", [opencodeAuth]),
  ];
}

function provider(
  input: Omit<Partial<ServerProvider>, "instanceId" | "driver"> & {
    instanceId: string;
    driver: string;
  },
): ServerProvider {
  return {
    installed: false,
    enabled: false,
    version: null,
    auth: { status: "unknown" },
    ...input,
  } as ServerProvider;
}

function emit(
  jobId: string,
  actionId: ProviderSetupActionId,
  providerName: ProviderSetupProvider,
  event:
    | { type: "started" }
    | { type: "progress"; text: string }
    | { type: "completed" }
    | { type: "failed"; message: string }
    | { type: "cancelled" },
): void {
  const base = {
    jobId,
    actionId,
    provider: providerName,
    timestamp: "2026-06-29T12:00:00.000Z",
  };
  const payload =
    event.type === "progress"
      ? { ...base, ...event, stream: "stdout" as const }
      : event.type === "completed"
        ? { ...base, ...event, exitCode: 0 as const }
        : event.type === "failed"
          ? { ...base, ...event, exitCode: 1 }
          : { ...base, ...event };
  const listener = harness.listeners.get(jobId);
  if (!listener) throw new Error(`No subscription registered for ${jobId}`);
  listener(payload as ProviderSetupJobEvent);
}

async function waitForJob(jobId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.listeners.has(jobId)).toBe(true);
  });
}

describe("provider setup", () => {
  beforeEach(() => {
    harness.reset();
    setCapabilities();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows installed, authenticated, enabled, and default provider states", async () => {
    harness.providers = [
      provider({
        instanceId: "codex-main",
        driver: "codex",
        installed: true,
        enabled: true,
        version: "1.2.3",
        auth: { status: "authenticated" },
      }),
      provider({
        instanceId: "claude-main",
        driver: "claudeAgent",
        installed: false,
        auth: { status: "unauthenticated" },
      }),
    ];
    harness.environmentStateById = {
      local: {
        projectById: {
          project: {
            defaultModelSelection: { instanceId: "codex-main" },
          },
        },
      },
    };

    const screen = await render(<ProviderSetupStep />);

    await expect.element(page.getByText("Installed · 1.2.3 · Authenticated")).toBeInTheDocument();
    await expect.element(page.getByText("Enabled")).toBeInTheDocument();
    await expect.element(page.getByText("Default")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Ready")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Install Codex" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign in with browser" })).toBeEnabled();

    await screen.unmount();
  });

  it("completes only with a supported authenticated Codex and disables other providers", async () => {
    harness.providers = [
      provider({
        instanceId: "codex-main",
        driver: "codex",
        installed: true,
        enabled: true,
        version: "0.144.3",
        auth: { status: "authenticated" },
      }),
    ];
    harness.settings = {
      ...harness.settings,
      providerInstances: {
        codex: { driver: "codex" },
        claudeAgent: { driver: "claudeAgent" },
      } as UnifiedSettings["providerInstances"],
    };
    const ref = createRef<ProviderSetupStepHandle>();
    const screen = await render(<ProviderSetupStep ref={ref} />);

    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    await expect(ref.current?.save()).resolves.toBe(true);
    expect(harness.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          codex: expect.objectContaining({ enabled: true }),
          claudeAgent: expect.objectContaining({ enabled: false }),
          cursor: expect.objectContaining({ enabled: false }),
          opencode: expect.objectContaining({ enabled: false }),
        }),
        providerInstances: { codex: { driver: "codex" } },
      }),
    );

    await screen.unmount();
  });

  it("fails closed when Codex is older than the permission-profile minimum", async () => {
    harness.providers = [
      provider({
        instanceId: "codex-main",
        driver: "codex",
        installed: true,
        enabled: true,
        version: "0.137.0",
        auth: { status: "authenticated" },
      }),
    ];
    const ref = createRef<ProviderSetupStepHandle>();
    const screen = await render(<ProviderSetupStep ref={ref} />);

    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    await expect(ref.current?.save()).resolves.toBe(false);
    await expect
      .element(page.getByText("Update Codex to 0.138.0 or newer before continuing."))
      .toBeInTheDocument();
    expect(harness.updateSettings).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it("starts install immediately, shows compact status, and marks success", async () => {
    const screen = await render(<ProviderSetupStep />);

    await page.getByRole("button", { name: "Install Codex" }).click();
    await vi.waitFor(() => {
      expect(harness.startProviderSetup).toHaveBeenCalledWith({
        actionId: "codex.install",
        confirmed: true,
      });
    });
    await waitForJob("job-1");

    emit("job-1", "codex.install", "codex", { type: "started" });
    emit("job-1", "codex.install", "codex", {
      type: "progress",
      text: "Installing package…",
    });
    await expect.element(page.getByText("Installing", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Study Buddy is installing Codex in the background."))
      .toBeInTheDocument();

    emit("job-1", "codex.install", "codex", { type: "completed" });
    await expect.element(page.getByText("Ready")).toBeInTheDocument();
    await expect.element(page.getByText("COMPLETED")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Authentication required")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(harness.refreshProviders).toHaveBeenCalledTimes(2);
    });
    expect(harness.listeners.has("job-1")).toBe(false);

    await screen.unmount();
  });

  it("renders Codex actions without waiting for slow provider discovery", async () => {
    let finishRefresh: (() => void) | undefined;
    harness.refreshProviders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve({});
        }),
    );

    const screen = await render(<ProviderSetupStep />);

    await expect.element(page.getByRole("button", { name: "Install Codex" })).toBeInTheDocument();
    await expect.element(page.getByText("Checking provider capabilities…")).not.toBeInTheDocument();

    finishRefresh?.();
    await screen.unmount();
  });

  it("shows failed jobs and retries the same allowlisted action", async () => {
    harness.providers = [
      provider({ instanceId: "codex", driver: "codex", installed: true, version: "0.144.3" }),
    ];
    const screen = await render(<ProviderSetupStep />);

    await page.getByRole("button", { name: "Sign in with browser" }).click();
    await waitForJob("job-1");
    emit("job-1", "codex.auth.browser", "codex", {
      type: "failed",
      message: "Browser authentication failed.",
    });

    await expect.element(page.getByText("Action failed")).toBeInTheDocument();
    await expect.element(page.getByText("Browser authentication failed.")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() => {
      expect(harness.startProviderSetup).toHaveBeenLastCalledWith({
        actionId: "codex.auth.browser",
      });
    });
    await waitForJob("job-2");

    await screen.unmount();
  });

  it("keeps non-Codex providers out of the Study Buddy setup", async () => {
    const screen = await render(<ProviderSetupStep />);

    await expect.element(page.getByText("Credential boundary")).toBeInTheDocument();
    await expect.element(page.getByText("Claude")).not.toBeInTheDocument();
    await expect.element(page.getByText("Cursor")).not.toBeInTheDocument();
    await expect.element(page.getByText("OpenCode")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Sign in to Claude" }))
      .not.toBeInTheDocument();

    await screen.unmount();
  });

  it("cancels running jobs and exposes retry after the cancellation event", async () => {
    harness.providers = [
      provider({ instanceId: "codex", driver: "codex", installed: true, version: "0.144.3" }),
    ];
    const screen = await render(<ProviderSetupStep />);

    await page.getByRole("button", { name: "Sign in with browser" }).click();
    await waitForJob("job-1");
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => {
      expect(harness.cancelProviderSetup).toHaveBeenCalledWith({ jobId: "job-1" });
    });

    emit("job-1", "codex.auth.browser", "codex", { type: "cancelled" });
    await expect.element(page.getByText("Action cancelled")).toBeInTheDocument();
    await expect.element(page.getByText("cancelled", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    await screen.unmount();
  });

  it("does not render setup actions for unsupported provider families", async () => {
    const screen = await render(<ProviderSetupStep />);

    await expect
      .element(page.getByRole("button", { name: "Install Cursor CLI" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Sign in to Claude" }))
      .not.toBeInTheDocument();

    await screen.unmount();
  });
});
