import type { TelemetryConsentDecision, TelemetryOutboxStatus } from "@t3tools/contracts";
import { CopyIcon, DatabaseIcon, ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { telemetry, telemetryProductionConfigured } from "../../telemetry/runtime";
import { systemTelemetryRandom } from "../../telemetry/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_STATUS: TelemetryOutboxStatus = {
  queuedBytes: 0,
  queuedItems: 0,
  oldestItemAt: null,
  lastSuccessfulSyncAt: null,
  droppedCount: 0,
  lastError: null,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PrivacySettingsPanel() {
  const settings = useSettings();
  const { updateClientSettingsDurably } = useUpdateSettings();
  const [status, setStatus] = useState<TelemetryOutboxStatus>(EMPTY_STATUS);
  const [savingCategory, setSavingCategory] = useState<"analytics" | "conversation" | null>(null);

  const refresh = useCallback(() => {
    void telemetry.diagnostics().then(setStatus);
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const changeConsent = async (
    category: "analytics" | "conversation",
    decision: TelemetryConsentDecision,
  ) => {
    const now = new Date().toISOString();
    const installationId =
      decision === "accepted" && !settings.installationId
        ? systemTelemetryRandom.uuid()
        : settings.installationId;
    setSavingCategory(category);
    try {
      const next = await updateClientSettingsDurably({
        installationId,
        consentVersion: 1,
        consentUpdatedAt: now,
        ...(category === "analytics"
          ? {
              analyticsConsent: decision,
              analyticsEnabledAt:
                decision === "accepted"
                  ? settings.analyticsConsent === "accepted"
                    ? (settings.analyticsEnabledAt ?? now)
                    : now
                  : null,
            }
          : {
              conversationConsent: decision,
              conversationEnabledAt:
                decision === "accepted"
                  ? settings.conversationConsent === "accepted"
                    ? (settings.conversationEnabledAt ?? now)
                    : now
                  : null,
            }),
      });
      await telemetry.updateConsent({
        hydrated: true,
        installationId: next.installationId || null,
        analyticsConsent: next.analyticsConsent,
        conversationConsent: next.conversationConsent,
        analyticsEnabledAt: next.analyticsEnabledAt,
        conversationEnabledAt: next.conversationEnabledAt,
      });
      if (category !== "analytics" || decision === "accepted") {
        void telemetry.capture({
          event: "settings.changed",
          properties: { section: "privacy", category },
        });
      }
      refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "Privacy choice was not saved",
        description: "Tracking was not changed. Retry after local storage is available.",
      });
    } finally {
      setSavingCategory(null);
    }
  };

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Privacy &amp; Data</h1>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          Independent consent controls and the local delivery queue. Disabling a category stops
          future capture and deletes its unsent items.
        </p>
      </div>

      <SettingsSection title="Consent" icon={<ShieldCheckIcon className="size-3.5" />}>
        <SettingsRow
          title="Usage analytics and click heatmaps"
          description="Only explicitly tagged controls; no replay, prompts, page text, terminal output, diffs, credentials, input values, or filesystem paths."
          status={
            settings.analyticsConsent === "accepted" && settings.analyticsEnabledAt
              ? `Future activity only · enabled ${new Date(settings.analyticsEnabledAt).toLocaleString()}`
              : "Off"
          }
          control={
            <Switch
              checked={settings.analyticsConsent === "accepted"}
              disabled={savingCategory !== null}
              aria-label="Share usage analytics"
              onCheckedChange={(checked) =>
                void changeConsent("analytics", checked ? "accepted" : "rejected")
              }
            />
          }
        />
        <SettingsRow
          title="Conversation sharing"
          description="Only completed user/assistant text and limited model, timing, outcome, and pseudonymous IDs."
          status={
            settings.conversationConsent === "accepted" && settings.conversationEnabledAt
              ? `Future completed turns only · enabled ${new Date(settings.conversationEnabledAt).toLocaleString()}`
              : "Off"
          }
          control={
            <Switch
              checked={settings.conversationConsent === "accepted"}
              disabled={savingCategory !== null}
              aria-label="Share completed conversations"
              onCheckedChange={(checked) =>
                void changeConsent("conversation", checked ? "accepted" : "rejected")
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Local outbox" icon={<DatabaseIcon className="size-3.5" />}>
        <SettingsRow
          title="Queue"
          description={`${status.queuedItems} items · ${formatBytes(status.queuedBytes)} · oldest ${status.oldestItemAt ? new Date(status.oldestItemAt).toLocaleString() : "none"}`}
          status={`Last sync: ${status.lastSuccessfulSyncAt ? new Date(status.lastSuccessfulSyncAt).toLocaleString() : "never"} · dropped: ${status.droppedCount}`}
          control={
            <Button
              size="sm"
              variant="outline"
              data-analytics-id="privacy.sync"
              onClick={() => void telemetry.flush().then(refresh)}
            >
              Sync now
            </Button>
          }
        />
        <SettingsRow
          title="Production destination"
          description={
            telemetryProductionConfigured
              ? "Configured for the self-hosted PostHog project."
              : "Project token is not configured; production telemetry remains disabled."
          }
          control={
            <Badge variant={telemetryProductionConfigured ? "success" : "secondary"}>
              {telemetryProductionConfigured ? "Configured" : "Disabled"}
            </Badge>
          }
        />
        {status.lastError ? (
          <SettingsRow title="Last delivery error" description={status.lastError} />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Your identifier">
        <SettingsRow
          title="Installation ID"
          description={settings.installationId || "Not created until a category is accepted."}
          control={
            settings.installationId ? (
              <Button
                size="sm"
                variant="outline"
                data-analytics-id="privacy.copy-installation-id"
                onClick={() => {
                  void navigator.clipboard.writeText(settings.installationId);
                  toastManager.add({ type: "success", title: "Installation ID copied" });
                }}
              >
                <CopyIcon className="size-3.5" />
                Copy
              </Button>
            ) : null
          }
        />
        <SettingsRow
          title="Full privacy notice"
          description="Data collected, exclusions, retention, withdrawal, and data-subject requests."
          control={
            <Button
              size="sm"
              variant="outline"
              data-analytics-id="privacy.open-notice"
              render={<Link to="/privacy" />}
            >
              Open
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
