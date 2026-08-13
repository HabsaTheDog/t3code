import {
  CheckCircle2Icon,
  DownloadIcon,
  HardDriveIcon,
  LanguagesIcon,
  MicIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useDesktopSpeechActions, useDesktopSpeechState } from "../../lib/desktopSpeechReactQuery";
import { cn } from "../../lib/utils";
import { captureFeatureExposureOnce } from "../../telemetry/featureExposure";
import { featureProperties } from "../../telemetry/featureCatalog";
import { telemetry } from "../../telemetry/runtime";
import { classifySpeechModelFailure } from "../../telemetry/speechTelemetry";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Spinner } from "../ui/spinner";

function formatBytes(value: number): string {
  if (value <= 0) return "0 MB";
  return `${Math.round(value / 1024 / 1024)} MB`;
}

export function SpeechModelCard({
  compact = false,
  surface,
}: {
  compact?: boolean;
  surface: "setup" | "settings";
}) {
  const query = useDesktopSpeechState();
  const actions = useDesktopSpeechActions();
  const [busy, setBusy] = useState(false);
  const state = query.data;
  const desktopAvailable = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const previousStatusRef = useRef(state?.status);
  const installing = state?.status === "downloading" || state?.status === "verifying";
  const ready = state?.status === "ready";
  const enabled = state && state.status !== "not-enabled";
  const percentage =
    state?.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
      : null;

  useEffect(() => {
    if (!desktopAvailable) return;
    void captureFeatureExposureOnce("voice.setup", surface);
  }, [desktopAvailable, surface]);

  useEffect(() => {
    if (!desktopAvailable) return;
    const previousStatus = previousStatusRef.current;
    const status = state?.status;
    previousStatusRef.current = status;
    const wasInstalling = previousStatus === "downloading" || previousStatus === "verifying";
    if (wasInstalling && status === "ready") {
      void telemetry.capture({
        event: "speech.model.install_completed",
        properties: { surface },
      });
    } else if (wasInstalling && status === "error") {
      void telemetry.capture({
        event: "speech.model.install_failed",
        properties: {
          surface,
          failure_kind: classifySpeechModelFailure(state?.error),
          failure_stage: previousStatus,
        },
      });
    }
  }, [desktopAvailable, state?.error, state?.status, surface]);

  const changeModel = async (action: "enable" | "remove") => {
    setBusy(true);
    try {
      if (action === "enable") {
        await actions.enable();
        void telemetry.capture({
          event: "speech.model.install_started",
          properties: { surface },
        });
      } else {
        await actions.remove();
        void telemetry.capture({
          event: "speech.model.removed",
          properties: { surface },
        });
      }
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("voice.setup", { action, surface }),
      });
    } catch (error) {
      if (action === "enable") {
        void telemetry.capture({
          event: "speech.model.install_failed",
          properties: {
            surface,
            failure_kind: classifySpeechModelFailure(
              error instanceof Error ? error.message : undefined,
            ),
            failure_stage: "request",
          },
        });
      } else {
        void telemetry.capture({
          event: "speech.model.remove_failed",
          properties: { surface, failure_kind: "unknown" },
        });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!desktopAvailable) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        Voice input is available in the Study Buddy desktop app.
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden border-border/80", compact ? "p-4" : "p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <MicIcon className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Voice input</h3>
              <p className="text-xs text-muted-foreground">Optional · works on your device</p>
            </div>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            Speak your message instead of typing it. Study Buddy turns your voice into text on this
            device, and the written transcript does not appear in the chat.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/80">
            <span className="inline-flex items-center gap-1.5">
              <HardDriveIcon className="size-3" /> About 478 MB
            </span>
            <span className="inline-flex items-center gap-1.5">
              <LanguagesIcon className="size-3" />
              25 European languages
            </span>
            <span>Works best with 4 GB or more of free memory</span>
            <span>Powered by Parakeet V3</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ready ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-500">
              <CheckCircle2Icon className="size-4" />
              Ready
            </span>
          ) : null}
          {enabled ? (
            <Button
              size="sm"
              variant="outline"
              data-analytics-id="speech.model.remove"
              disabled={busy || installing}
              onClick={() => void changeModel("remove")}
            >
              <Trash2Icon className="size-3.5" />
              Remove
            </Button>
          ) : (
            <Button
              size="sm"
              data-analytics-id="speech.model.download"
              disabled={busy}
              onClick={() => void changeModel("enable")}
            >
              {busy ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
              Download voice input
            </Button>
          )}
        </div>
      </div>

      {installing ? (
        <div className="mt-4 space-y-2" aria-live="polite">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-500",
                percentage === null && "w-1/3 animate-pulse",
              )}
              style={percentage === null ? undefined : { width: `${percentage}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {state.status === "verifying"
              ? "Finishing voice input setup…"
              : percentage === null
                ? `Downloading voice input… ${formatBytes(state.downloadedBytes)}`
                : `Downloading voice input… ${percentage}% (${formatBytes(state.downloadedBytes)} of ${formatBytes(state.totalBytes ?? 0)})`}{" "}
            You can finish setup while this continues in the background.
          </p>
        </div>
      ) : state?.status === "error" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">
            {state.error ?? "We couldn’t add voice input."}
          </p>
          <Button
            size="xs"
            variant="outline"
            data-analytics-id="speech.model.retry"
            onClick={() => void changeModel("enable")}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
