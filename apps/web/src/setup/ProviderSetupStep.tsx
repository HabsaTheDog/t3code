import type {
  ProviderSetupAction,
  ProviderSetupCapability,
  ProviderSetupJobEvent,
  ProviderSetupProvider,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  defaultInstanceIdForDriver,
  MINIMUM_STUDY_BUDDY_CODEX_VERSION,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  DownloadIcon,
  GlobeIcon,
  InfoIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { ClaudeAI, CursorIcon, OpenAI, OpenCodeIcon, type Icon } from "../components/Icons";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { buildProviderInstanceUpdatePatch } from "../components/settings/SettingsPanels.logic";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { useServerProviders } from "../rpc/serverState";
import { useStore } from "../store";
import { registerTelemetrySecret, telemetry } from "../telemetry/runtime";

const PROVIDER_ORDER: readonly ProviderSetupProvider[] = ["codex"];
const PROVIDER_DRIVER_BY_SETUP_NAME = {
  codex: ProviderDriverKind.make("codex"),
  claude: ProviderDriverKind.make("claudeAgent"),
  cursor: ProviderDriverKind.make("cursor"),
  opencode: ProviderDriverKind.make("opencode"),
} satisfies Record<ProviderSetupProvider, ReturnType<typeof ProviderDriverKind.make>>;
const SECRET_ENV_BY_ACTION_ID: Readonly<Record<string, string | undefined>> = {
  "claude.auth.api-key": "ANTHROPIC_API_KEY",
};

type JobStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

interface ProviderJob {
  readonly action: ProviderSetupAction;
  readonly jobId?: string;
  readonly status: JobStatus;
  readonly progress: readonly string[];
  readonly error?: string;
}

const terminalEvent = (event: ProviderSetupJobEvent): boolean =>
  event.type === "completed" || event.type === "failed" || event.type === "cancelled";

const actionForRetry = (job: ProviderJob | undefined): ProviderSetupAction | null =>
  job?.status === "failed" || job?.status === "cancelled" ? job.action : null;

const PROVIDER_ICON_BY_NAME: Record<ProviderSetupProvider, Icon> = {
  codex: OpenAI,
  claude: ClaudeAI,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
};

function getActionIcon(action: ProviderSetupAction) {
  if (action.kind === "install") return DownloadIcon;
  if (action.id.endsWith(".api-key") || action.id.endsWith(".access-token")) return KeyRoundIcon;
  if (action.id.endsWith(".device-code")) return SmartphoneIcon;
  return GlobeIcon;
}

function getJobStatusCopy(
  job: ProviderJob,
  providerLabel: string,
): {
  title: string;
  detail: string;
  tone: "idle" | "running" | "success" | "error";
} {
  if (job.status === "completed") {
    return {
      title: "Ready",
      detail: `${providerLabel} setup finished successfully.`,
      tone: "success",
    };
  }
  if (job.status === "failed") {
    return {
      title: "Action failed",
      detail: job.error ?? "The setup action could not be completed.",
      tone: "error",
    };
  }
  if (job.status === "cancelled") {
    return {
      title: "Action cancelled",
      detail: "No changes were applied after cancellation.",
      tone: "idle",
    };
  }
  if (job.action.kind === "install") {
    return {
      title: "Installing",
      detail: `Study Buddy is installing ${providerLabel} in the background.`,
      tone: "running",
    };
  }
  if (job.action.id.endsWith(".api-key")) {
    return {
      title: "Saving API key",
      detail: `Study Buddy is configuring ${providerLabel} without exposing the secret in the UI.`,
      tone: "running",
    };
  }
  if (job.action.id.endsWith(".access-token")) {
    return {
      title: "Saving access token",
      detail: `Study Buddy is configuring ${providerLabel} without exposing the token in the UI.`,
      tone: "running",
    };
  }
  if (job.action.id.endsWith(".device-code")) {
    return {
      title: "Waiting for device sign-in",
      detail: `Complete the device flow outside Study Buddy, then return here.`,
      tone: "running",
    };
  }
  return {
    title: "Waiting for sign-in",
    detail: `Complete the ${providerLabel} sign-in flow in the browser or external prompt.`,
    tone: "running",
  };
}

function ProviderStatusIndicator(props: {
  installed: boolean;
  authenticated: boolean;
  installJustCompleted: boolean;
}) {
  const needsAuthentication =
    (props.installed || props.installJustCompleted) && !props.authenticated;

  if (props.authenticated) {
    return <CheckCircle2Icon className="size-5 shrink-0 text-emerald-500" aria-label="Ready" />;
  }

  if (!needsAuthentication) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="shrink-0 rounded-full text-sky-400 transition-colors hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
            aria-label="Authentication required"
          >
            <InfoIcon className="size-5" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-relaxed">
        This provider is installed, but you still need to sign in before it is ready.
      </TooltipPopup>
    </Tooltip>
  );
}

export function summarizeProvider(
  providers: ReadonlyArray<ServerProvider>,
  driver: ProviderSetupProvider,
): {
  installed: boolean;
  authenticated: boolean;
  selected: boolean;
  version: string | null;
} {
  const runtimeDrivers =
    driver === "claude" ? new Set(["claude", "claudeAgent"]) : new Set([driver]);
  const matches = providers.filter((provider) => runtimeDrivers.has(provider.driver));
  const installed = matches.find((provider) => provider.installed);
  return {
    installed: installed !== undefined,
    authenticated: matches.some(
      (provider) => provider.installed && provider.auth.status === "authenticated",
    ),
    selected: matches.some((provider) => provider.enabled),
    version: installed?.version ?? null,
  };
}

export function visibleProviderActions(
  capability: ProviderSetupCapability | undefined,
  installed: boolean,
): ReadonlyArray<ProviderSetupAction> {
  return capability?.actions.filter((action) => !installed || action.kind === "authenticate") ?? [];
}

export function providerIsDefault(
  providers: ReadonlyArray<ServerProvider>,
  driver: ProviderSetupProvider,
  defaultInstanceIds: ReadonlySet<string>,
): boolean {
  const runtimeDrivers =
    driver === "claude" ? new Set(["claude", "claudeAgent"]) : new Set([driver]);
  return providers.some(
    (provider) =>
      runtimeDrivers.has(provider.driver) && defaultInstanceIds.has(provider.instanceId),
  );
}

export interface ProviderSetupStepHandle {
  readonly save: () => Promise<boolean>;
}

export const ProviderSetupStep = forwardRef<ProviderSetupStepHandle>(
  function ProviderSetupStep(_props, ref) {
    const providers = useServerProviders();
    const settings = useSettings(
      (current): Pick<UnifiedSettings, "providers" | "providerInstances"> => ({
        providers: current.providers,
        providerInstances: current.providerInstances,
      }),
    );
    const { updateSettings } = useUpdateSettings();
    const environmentStates = useStore((state) => state.environmentStateById);
    const [capabilities, setCapabilities] = useState<ReadonlyArray<ProviderSetupCapability> | null>(
      null,
    );
    const [loadError, setLoadError] = useState<string | null>(null);
    const [readinessError, setReadinessError] = useState<string | null>(null);
    const [jobs, setJobs] = useState<Partial<Record<ProviderSetupProvider, ProviderJob>>>({});
    const [apiKeyDialog, setApiKeyDialog] = useState<{
      provider: ProviderSetupProvider;
      action: ProviderSetupAction;
    } | null>(null);
    const [secretValues, setSecretValues] = useState<
      Partial<Record<ProviderSetupProvider, string>>
    >({});
    const subscriptions = useRef(new Map<string, () => void>());

    const loadCapabilities = async () => {
      setLoadError(null);
      try {
        const api = ensureLocalApi().server;
        const nextCapabilities = await api.getProviderSetupCapabilities();
        setCapabilities(nextCapabilities);
        // Provider discovery may spawn the Codex executable and can take several
        // seconds on a cold start. The setup actions are static backend
        // capabilities, so render them immediately and refresh status in the
        // background instead of holding the entire Codex step behind discovery.
        void api.refreshProviders().catch(() => undefined);
      } catch {
        setLoadError("Provider setup is unavailable until a backend is connected.");
        setCapabilities([]);
      }
    };

    useEffect(() => {
      void loadCapabilities();
      return () => {
        for (const unsubscribe of subscriptions.current.values()) unsubscribe();
        subscriptions.current.clear();
      };
    }, []);

    const capabilityByProvider = useMemo(
      () => new Map(capabilities?.map((capability) => [capability.provider, capability]) ?? []),
      [capabilities],
    );
    const codexStatus = summarizeProvider(providers, "codex");
    const codexVersionSupported =
      codexStatus.version !== null &&
      compareSemverVersions(codexStatus.version, MINIMUM_STUDY_BUDDY_CODEX_VERSION) >= 0;
    const codexReady = codexStatus.installed && codexStatus.authenticated && codexVersionSupported;

    useImperativeHandle(
      ref,
      () => ({
        save: async () => {
          if (codexReady) {
            setReadinessError(null);
            updateSettings({
              providers: {
                codex: { ...settings.providers.codex, enabled: true },
                claudeAgent: { ...settings.providers.claudeAgent, enabled: false },
                cursor: { ...settings.providers.cursor, enabled: false },
                opencode: { ...settings.providers.opencode, enabled: false },
              },
              providerInstances: Object.fromEntries(
                Object.entries(settings.providerInstances).filter(
                  ([, instance]) => instance.driver === "codex",
                ),
              ),
            });
            return true;
          }
          setReadinessError(
            !codexStatus.installed
              ? "Install Codex before continuing."
              : !codexVersionSupported
                ? `Update Codex to ${MINIMUM_STUDY_BUDDY_CODEX_VERSION} or newer before continuing.`
                : "Sign in to Codex before continuing.",
          );
          return false;
        },
      }),
      [
        codexReady,
        codexStatus.authenticated,
        codexStatus.installed,
        codexVersionSupported,
        settings.providerInstances,
        updateSettings,
      ],
    );
    const defaultInstanceIds = useMemo(
      () =>
        new Set(
          Object.values(environmentStates).flatMap((environment) =>
            Object.values(environment.projectById).flatMap((project) =>
              project.defaultModelSelection ? [project.defaultModelSelection.instanceId] : [],
            ),
          ),
        ),
      [environmentStates],
    );

    const updateFromEvent = (event: ProviderSetupJobEvent) => {
      setJobs((current) => {
        const previous = current[event.provider];
        if (!previous || previous.jobId !== event.jobId) return current;
        if (event.type === "started") {
          return { ...current, [event.provider]: { ...previous, status: "running" } };
        }
        if (event.type === "progress") {
          return {
            ...current,
            [event.provider]: {
              ...previous,
              status: "running",
              progress: [...previous.progress, event.text].slice(-80),
            },
          };
        }
        if (event.type === "completed") {
          return { ...current, [event.provider]: { ...previous, status: "completed" } };
        }
        if (event.type === "cancelled") {
          return { ...current, [event.provider]: { ...previous, status: "cancelled" } };
        }
        return {
          ...current,
          [event.provider]: { ...previous, status: "failed", error: event.message },
        };
      });

      if (terminalEvent(event)) {
        const eventPrefix = event.actionId.includes(".install")
          ? "provider.install"
          : "provider.auth";
        void telemetry.capture({
          event: event.type === "completed" ? `${eventPrefix}_completed` : `${eventPrefix}_failed`,
          properties: {
            provider: event.provider,
            action: event.actionId,
            outcome: event.type,
          },
        });
        const unsubscribe = subscriptions.current.get(event.jobId);
        unsubscribe?.();
        subscriptions.current.delete(event.jobId);
        void ensureLocalApi()
          .server.refreshProviders()
          .catch(() => undefined);
      }
    };

    const startAction = async (provider: ProviderSetupProvider, action: ProviderSetupAction) => {
      const secret = secretValues[provider]?.trim();
      setApiKeyDialog(null);
      setJobs((current) => ({
        ...current,
        [provider]: { action, status: "starting", progress: [] },
      }));
      void telemetry.capture({
        event: action.kind === "install" ? "provider.install_started" : "provider.auth_started",
        properties: { provider, action: action.id },
      });

      try {
        if (secret) registerTelemetrySecret(secret);
        const result = await ensureLocalApi().server.startProviderSetup({
          actionId: action.id,
          ...(action.requiresConfirmation ? { confirmed: true } : {}),
          ...(action.secretInput !== null ? { secretValue: secret ?? "" } : {}),
        });
        setSecretValues((current) => ({ ...current, [provider]: "" }));
        setJobs((current) => ({
          ...current,
          [provider]: {
            ...(current[provider] ?? { action, progress: [] }),
            jobId: result.jobId,
            status: "running",
          },
        }));
        const unsubscribe = ensureLocalApi().server.subscribeProviderSetupJob(
          { jobId: result.jobId },
          updateFromEvent,
        );
        subscriptions.current.set(result.jobId, unsubscribe);
      } catch {
        setJobs((current) => ({
          ...current,
          [provider]: {
            action,
            status: "failed",
            progress: [],
            error: "The setup action could not be started. Check the backend and retry.",
          },
        }));
        void telemetry.capture({
          event: action.kind === "install" ? "provider.install_failed" : "provider.auth_failed",
          properties: { provider, action: action.id, outcome: "start_failed" },
        });
      }
    };

    const persistEnvironmentSecret = async (
      provider: ProviderSetupProvider,
      action: ProviderSetupAction,
    ) => {
      const secret = secretValues[provider]?.trim();
      const envName = SECRET_ENV_BY_ACTION_ID[action.id];
      if (!secret || !envName) return;

      registerTelemetrySecret(secret);
      const driver = PROVIDER_DRIVER_BY_SETUP_NAME[provider];
      const instanceId = defaultInstanceIdForDriver(driver);
      const currentInstance =
        settings.providerInstances[instanceId] ??
        ({
          driver,
        } satisfies ProviderInstanceConfig);
      const nextEnvironment: ProviderInstanceEnvironmentVariable[] = [
        ...(currentInstance.environment ?? []).filter((variable) => variable.name !== envName),
        { name: envName, value: secret, sensitive: true },
      ];

      updateSettings(
        buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          instance: {
            ...currentInstance,
            environment: nextEnvironment,
          },
          driver,
          isDefault: true,
        }),
      );
      setApiKeyDialog(null);
      setSecretValues((current) => ({ ...current, [provider]: "" }));
      void telemetry.capture({
        event: "provider.auth_completed",
        properties: { provider, action: action.id, outcome: "stored_secret" },
      });
      void ensureLocalApi()
        .server.refreshProviders()
        .catch(() => undefined);
    };

    const requestAction = (provider: ProviderSetupProvider, action: ProviderSetupAction) => {
      if (action.secretInput !== null) {
        setApiKeyDialog({ provider, action });
        return;
      }
      void startAction(provider, action);
    };

    const cancelJob = async (provider: ProviderSetupProvider, job: ProviderJob) => {
      if (!job.jobId) return;
      try {
        await ensureLocalApi().server.cancelProviderSetup({ jobId: job.jobId });
      } catch {
        setJobs((current) => ({
          ...current,
          [provider]: { ...job, error: "The running job could not be cancelled." },
        }));
      }
    };

    if (capabilities === null) {
      return (
        <Card className="grid min-h-48 place-items-center border-dashed">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Checking provider capabilities…
          </div>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        <Card className="overflow-hidden rounded-[1.75rem] border-emerald-500/20 bg-emerald-500/6">
          <div className="grid gap-4 p-5 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="grid size-12 place-items-center rounded-2xl border border-emerald-500/25 bg-background/80 text-emerald-500">
              <ShieldAlertIcon className="size-5" />
            </div>
            <div>
              <p className="font-semibold">Credential boundary</p>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Study Buddy runs this Codex installation from a private app-owned home. Credential
                files are denied, login pages stay locked, and spawned commands receive no Moodle or
                CIS secrets.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">Codex {MINIMUM_STUDY_BUDDY_CODEX_VERSION}+</Badge>
                <Badge variant="secondary">Private runtime</Badge>
                <Badge variant="secondary">Secrets denied</Badge>
              </div>
            </div>
          </div>
        </Card>

        {loadError ? (
          <div
            className="flex items-center justify-between gap-4 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm"
            role="status"
          >
            <span className="flex items-center gap-2">
              <AlertCircleIcon className="size-4 text-amber-500" />
              {loadError}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void loadCapabilities()}>
              Retry
            </Button>
          </div>
        ) : null}

        {readinessError ? (
          <p className="text-sm text-destructive" role="alert">
            {readinessError}
          </p>
        ) : null}

        <div className="grid gap-4">
          {PROVIDER_ORDER.map((providerName) => {
            const capability = capabilityByProvider.get(providerName);
            const status = summarizeProvider(providers, providerName);
            const isDefault = providerIsDefault(providers, providerName, defaultInstanceIds);
            const job = jobs[providerName];
            const running = job?.status === "starting" || job?.status === "running";
            const actions = visibleProviderActions(capability, status.installed);
            const retryAction = actionForRetry(job);
            const unsupported = actions.length > 0 && actions.every((action) => !action.supported);
            const providerLabel =
              capability?.displayName ??
              providerName.charAt(0).toUpperCase() + providerName.slice(1);
            const ProviderIcon = PROVIDER_ICON_BY_NAME[providerName];
            const statusCopy = job ? getJobStatusCopy(job, providerLabel) : null;
            const installJustCompleted =
              job?.status === "completed" && job.action.kind === "install";

            return (
              <Card
                key={providerName}
                className="overflow-hidden rounded-[1.75rem] border-border/75 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] shadow-sm"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background/80 shadow-sm">
                        <ProviderIcon className="size-6" />
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold">{providerLabel}</h3>
                          {status.selected ? <Badge variant="secondary">Enabled</Badge> : null}
                          {isDefault ? <Badge variant="secondary">Default</Badge> : null}
                          {!status.installed ? (
                            <Badge variant="outline">Install required</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {status.installed
                            ? `Installed${status.version ? ` · ${status.version}` : ""}`
                            : "Not installed"}
                          {" · "}
                          {status.authenticated ? "Authenticated" : "Not authenticated"}
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.18em] text-muted-foreground/80">
                          {status.installed ? "Connection actions" : "Install first"}
                        </p>
                      </div>
                    </div>
                    <ProviderStatusIndicator
                      installed={status.installed}
                      authenticated={status.authenticated}
                      installJustCompleted={installJustCompleted}
                    />
                  </div>

                  {unsupported ? (
                    <div className="mt-5 rounded-2xl border border-border/70 bg-muted/45 p-3 text-xs leading-5 text-muted-foreground">
                      <p className="flex items-center gap-1.5 font-medium text-foreground">
                        <ShieldAlertIcon className="size-3.5" />
                        Manual setup required
                      </p>
                      <p className="mt-1">
                        {actions.find((action) => action.unsupportedReason)?.unsupportedReason ??
                          "This provider is not supported on the current platform."}
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-5 grid gap-2">
                    {actions.map((action) =>
                      (() => {
                        const ActionIcon = getActionIcon(action);
                        return (
                          <Button
                            key={action.id}
                            size="lg"
                            variant={action.kind === "install" ? "default" : "outline"}
                            className={cn(
                              "h-auto min-h-12 justify-start gap-3 rounded-2xl px-4 py-3 text-left",
                              action.kind === "install" &&
                                "bg-foreground text-background hover:bg-foreground/90",
                            )}
                            data-analytics-id={`provider.${action.id}`}
                            disabled={
                              running ||
                              !action.supported ||
                              (!status.installed && action.kind === "authenticate")
                            }
                            onClick={() => requestAction(providerName, action)}
                          >
                            <ActionIcon className="size-4 shrink-0" />
                            <span className="flex flex-1 items-center justify-between gap-3">
                              <span className="flex flex-col items-start">
                                <span>{action.label}</span>
                                {!status.installed && action.kind === "authenticate" ? (
                                  <span className="text-xs text-current/70">
                                    Available after install
                                  </span>
                                ) : null}
                              </span>
                              <ArrowUpRightIcon className="size-4 shrink-0 opacity-60" />
                            </span>
                          </Button>
                        );
                      })(),
                    )}
                    {retryAction ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-analytics-id="provider.retry"
                        disabled={
                          retryAction.secretInput !== null && !secretValues[providerName]?.trim()
                        }
                        onClick={() => requestAction(providerName, retryAction)}
                      >
                        <RefreshCwIcon className="size-3.5" />
                        Retry
                      </Button>
                    ) : null}
                    {running && job?.jobId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-analytics-id="provider.cancel"
                        onClick={() => void cancelJob(providerName, job)}
                      >
                        <CircleStopIcon className="size-3.5" />
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </div>

                {job && statusCopy ? (
                  <div
                    className={cn(
                      "border-t px-5 py-4",
                      statusCopy.tone === "running" && "border-sky-500/20 bg-sky-500/6",
                      statusCopy.tone === "success" && "border-emerald-500/20 bg-emerald-500/7",
                      statusCopy.tone === "error" && "border-rose-500/20 bg-rose-500/8",
                      statusCopy.tone === "idle" && "border-border/60 bg-muted/35",
                    )}
                    data-ph-no-capture
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          {statusCopy.tone === "running" ? <Spinner className="size-4" /> : null}
                          {statusCopy.title}
                        </p>
                        <p className="text-sm text-muted-foreground">{statusCopy.detail}</p>
                      </div>
                      <span className="shrink-0 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {job.status}
                      </span>
                    </div>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>

        <Dialog
          open={apiKeyDialog !== null}
          onOpenChange={(open) => (!open ? setApiKeyDialog(null) : null)}
        >
          <DialogPopup className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {apiKeyDialog?.action.secretInput === "access-token"
                  ? "Sign in with access token"
                  : "Sign in with API key"}
              </DialogTitle>
              <DialogDescription>
                {apiKeyDialog?.action.id === "claude.auth.api-key"
                  ? "Paste the key once. Study Buddy stores it on the Claude provider instance as ANTHROPIC_API_KEY and never renders it back into the interface."
                  : "Paste the secret once. Study Buddy sends it directly to the provider setup flow and never renders it back into the interface."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <KeyRoundIcon className="size-4" />
                  {apiKeyDialog?.action.secretInput === "access-token" ? "Access token" : "API key"}
                </span>
                <Input
                  nativeInput
                  type="password"
                  value={apiKeyDialog ? (secretValues[apiKeyDialog.provider] ?? "") : ""}
                  autoComplete="off"
                  placeholder="Write-only; never shown again"
                  className="ph-no-capture"
                  data-ph-no-capture
                  onChange={(event) =>
                    apiKeyDialog
                      ? setSecretValues((current) => ({
                          ...current,
                          [apiKeyDialog.provider]: event.currentTarget.value,
                        }))
                      : undefined
                  }
                />
              </label>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setApiKeyDialog(null)}>
                Cancel
              </Button>
              <Button
                disabled={!apiKeyDialog || !secretValues[apiKeyDialog.provider]?.trim()}
                onClick={() => {
                  if (!apiKeyDialog) return undefined;
                  if (apiKeyDialog.action.id === "claude.auth.api-key") {
                    void persistEnvironmentSecret(apiKeyDialog.provider, apiKeyDialog.action);
                    return undefined;
                  }
                  return void startAction(apiKeyDialog.provider, apiKeyDialog.action);
                }}
              >
                Continue
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </div>
    );
  },
);
