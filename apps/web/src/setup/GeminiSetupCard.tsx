import {
  ProviderInstanceId,
  type ProviderManageInput,
  type ProviderManageResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Gemini } from "../components/Icons";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { useServerProviders } from "../rpc/serverState";

export function GeminiSetupCard() {
  const settings = useSettings();
  const providers = useServerProviders();
  const instanceId = ProviderInstanceId.make("antigravity");
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const [state, setState] = useState<ProviderManageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const result = await ensureLocalApi().server.manageProvider({ instanceId, action: "status" });
    if (mounted.current) setState(result);
    return result;
  }, [instanceId]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        /* Action errors have an explicit retry below. */
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  const run = async (action: ProviderManageInput["action"]) => {
    setBusy(true);
    setError(null);
    try {
      if (action === "install" || action === "auth-start") {
        const current = settings.providerInstances[instanceId];
        await ensureLocalApi().server.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: {
              ...current,
              driver: "antigravity",
              enabled: true,
              config: current?.config ?? settings.providers.antigravity,
            },
          },
        });
      }
      const result = await ensureLocalApi().server.manageProvider({
        instanceId,
        action,
        ...(state?.auth.flowId ? { flowId: state.auth.flowId } : {}),
        ...(state?.install.operationId ? { operationId: state.install.operationId } : {}),
        ...(action === "auth-complete" ? { callbackUrl } : {}),
      });
      if (mounted.current) {
        setState(result);
        setCallbackUrl("");
      }
      await ensureLocalApi().server.refreshProviders();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Setup failed. Please retry.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const installing =
    state && ["downloading", "extracting", "verifying"].includes(state.install.phase);
  const authenticating = state && ["starting", "waiting", "verifying"].includes(state.auth.phase);
  const installed = provider?.installed || state?.install.phase === "succeeded";
  const ready = provider?.auth.status === "authenticated" || state?.auth.phase === "succeeded";
  return (
    <Card className="rounded-[1.75rem] p-5">
      <div className="flex items-center gap-4">
        <Gemini className="size-6" />
        <div>
          <h3 className="font-semibold">Google Gemini</h3>
          <p className="text-sm text-muted-foreground">
            {ready
              ? "Signed in"
              : installed
                ? provider?.auth.status === "unknown"
                  ? "Check your saved connection or sign in"
                  : "Sign-in needed"
                : "Install Antigravity to connect your Google account"}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {!installed && !installing ? (
          <Button disabled={busy} onClick={() => void run("install")}>
            Install Antigravity
          </Button>
        ) : null}
        {installed && !authenticating ? (
          <>
            {!ready ? (
              <Button disabled={busy} variant="outline" onClick={() => void run("refresh-models")}>
                Check connection
              </Button>
            ) : null}
            <Button disabled={busy} onClick={() => void run("auth-start")}>
              {ready ? "Change Google account" : "Sign in with Google"}
            </Button>
          </>
        ) : null}
        {installing ? (
          <Button disabled={busy} variant="outline" onClick={() => void run("install-cancel")}>
            Cancel installation
          </Button>
        ) : null}
        {authenticating ? (
          <Button disabled={busy} variant="outline" onClick={() => void run("auth-cancel")}>
            Cancel sign-in
          </Button>
        ) : null}
        {ready ? (
          <>
            <Button disabled={busy} variant="outline" onClick={() => void run("logout")}>
              Disconnect Google
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => void run("refresh-models")}>
              Refresh models
            </Button>
          </>
        ) : null}
      </div>
      {installing ? (
        <p role="status" className="mt-3 text-sm">
          {state.install.phase} · {Math.round(state.install.downloadedBytes / 1024 / 1024)} MB
          {state.install.totalBytes
            ? ` / ${Math.round(state.install.totalBytes / 1024 / 1024)} MB`
            : ""}
        </p>
      ) : null}
      {state?.auth.authorizationUrl ? (
        <div className="mt-3 space-y-2" data-ph-no-capture>
          <Button
            onClick={() =>
              void ensureLocalApi()
                .shell.openExternal(state.auth.authorizationUrl!)
                .catch(() => setError("Could not open your browser. Please retry."))
            }
          >
            Open Google sign-in
          </Button>
          <p className="text-sm text-muted-foreground">
            After signing in, return here. If the browser cannot reach the callback, paste its
            address below.
          </p>
          <Input
            type="password"
            autoComplete="off"
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.currentTarget.value)}
            placeholder="Sign-in callback address"
          />
          <Button disabled={!callbackUrl.trim() || busy} onClick={() => void run("auth-complete")}>
            Complete sign-in
          </Button>
        </div>
      ) : null}
      {error || state?.auth.message || state?.install.message ? (
        <p role="status" className="mt-3 text-sm" data-ph-no-capture>
          {error ?? state?.auth.message ?? state?.install.message}
        </p>
      ) : null}
    </Card>
  );
}
