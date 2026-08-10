import type { TelemetryConsentDecision, TelemetryOutboxStatus } from "@t3tools/contracts";
import { CopyIcon, DatabaseIcon, ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { telemetry, telemetryProductionConfigured } from "../../telemetry/runtime";
import { systemTelemetryRandom } from "../../telemetry/types";
import { featureProperties } from "../../telemetry/featureCatalog";
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
        void telemetry.capture({
          event: "feature.used",
          properties: featureProperties("settings.privacy", {
            setting_category: category,
          }),
        });
      }
      refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "We couldn’t save your choice",
        description: "Nothing changed. Please try again.",
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
          Help us improve Study Buddy by sharing how you use the app. Sharing is optional, off until
          you turn it on, and you can change your mind at any time.
        </p>
      </div>

      <SettingsSection
        title="Help improve Study Buddy"
        icon={<ShieldCheckIcon className="size-3.5" />}
      >
        <SettingsRow
          title="Usage analytics"
          description="Share which parts of Study Buddy you use and roughly where people click on each screen. We never include exact page addresses, what you type, mouse movement, scrolling, course content, passwords, or file contents."
          status={
            settings.analyticsConsent === "accepted" && settings.analyticsEnabledAt
              ? `Sharing new activity since ${new Date(settings.analyticsEnabledAt).toLocaleString()}`
              : "Not sharing"
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
          description="Share your messages, Study Buddy’s replies, and any feedback you leave, plus basic details about files it creates or changes. Passwords and file contents are not included."
          status={
            settings.conversationConsent === "accepted" && settings.conversationEnabledAt
              ? `Sharing new conversations since ${new Date(settings.conversationEnabledAt).toLocaleString()}`
              : "Not sharing"
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

      <SettingsSection title="Sharing status" icon={<DatabaseIcon className="size-3.5" />}>
        <SettingsRow
          title="Waiting to be sent"
          description={
            status.queuedItems === 0
              ? "Nothing is waiting to be sent."
              : `${status.queuedItems} ${status.queuedItems === 1 ? "item is" : "items are"} waiting (${formatBytes(status.queuedBytes)}).`
          }
          status={`Last sent: ${status.lastSuccessfulSyncAt ? new Date(status.lastSuccessfulSyncAt).toLocaleString() : "Not yet"}`}
          control={
            <Button
              size="sm"
              variant="outline"
              data-analytics-id="privacy.sync"
              onClick={() => void telemetry.flush().then(refresh)}
            >
              Send now
            </Button>
          }
        />
        <SettingsRow
          title="Sharing service"
          description={
            telemetryProductionConfigured
              ? "Study Buddy’s private analytics service is ready."
              : "Sharing is currently unavailable, so nothing will be sent."
          }
          control={
            <Badge variant={telemetryProductionConfigured ? "success" : "secondary"}>
              {telemetryProductionConfigured ? "Available" : "Unavailable"}
            </Badge>
          }
        />
        {status.lastError ? (
          <SettingsRow title="Problem sending data" description={status.lastError} />
        ) : null}
      </SettingsSection>

      <SettingsSection title="More information">
        <SettingsRow
          title="Your Study Buddy ID"
          description="A random ID helps us keep shared data together without using your name or email address."
          status={settings.installationId || "Created only if you choose to share."}
          control={
            settings.installationId ? (
              <Button
                size="sm"
                variant="outline"
                data-analytics-id="privacy.copy-installation-id"
                onClick={() => {
                  void navigator.clipboard.writeText(settings.installationId);
                  toastManager.add({ type: "success", title: "Study Buddy ID copied" });
                }}
              >
                <CopyIcon className="size-3.5" />
                Copy
              </Button>
            ) : null
          }
        />
        <SettingsRow
          title="Privacy notice"
          description="See exactly what can be shared, how long we keep it, and how to ask for a copy or deletion."
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
