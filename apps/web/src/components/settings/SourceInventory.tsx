import type {
  StudyBuddySourceBlock,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
  StudyBuddySourceTestResult,
} from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { featureProperties } from "../../telemetry/featureCatalog";
import { telemetry } from "../../telemetry/runtime";
import { sourceTelemetryProperties } from "../../telemetry/sourceTelemetry";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SourceDialog } from "./SourceDialog";
import { EmailInboxDialog } from "./EmailInboxDialog";
import { capabilityLabel, healthLabel, SOURCE_KIND_PRESENTATION } from "./sourcePresentation";

export function SourceInventory({
  inventory,
  addRequest = 0,
  onInventoryChange,
}: {
  inventory: StudyBuddySourceInventory;
  addRequest?: number;
  onInventoryChange: (inventory: StudyBuddySourceInventory) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [removingSourceId, setRemovingSourceId] = useState<string | null>(null);
  const [emailSourceId, setEmailSourceId] = useState<string | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, StudyBuddySourceTestResult>>({});

  const connections = useMemo(
    () => new Map(inventory.connections.map((connection) => [connection.id, connection])),
    [inventory.connections],
  );
  const orderedSources = useMemo(
    () =>
      [...inventory.sources].sort(
        (a, b) => a.priority - b.priority || a.label.localeCompare(b.label),
      ),
    [inventory.sources],
  );
  const editingSource = inventory.sources.find((source) => source.id === editingSourceId);
  const editingConnection = editingSource ? connections.get(editingSource.connectionId) : undefined;
  const removingSource = inventory.sources.find((source) => source.id === removingSourceId);
  const emailSource = inventory.sources.find((source) => source.id === emailSourceId);

  useEffect(() => {
    if (addRequest <= 0) return;
    setEditingSourceId(null);
    setDialogOpen(true);
  }, [addRequest]);

  const testSource = async (source: StudyBuddySourceBlock) => {
    setBusySourceId(source.id);
    try {
      const result = await ensureLocalApi().server.testStudyBuddySource({ sourceId: source.id });
      setTestResults((current) => ({ ...current, [source.id]: result }));
      void telemetry.capture({
        event: "source.connection.tested",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          outcome: result.status,
        },
      });
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("sources.connection", {
          surface: "settings",
          source_kind: source.kind,
        }),
      });
      if (source.kind === "email" && result.status === "success") {
        onInventoryChange(await ensureLocalApi().server.getStudyBuddySourceInventory());
      }
      toastManager.add({
        type:
          result.status === "success"
            ? "success"
            : result.status === "action-required"
              ? "info"
              : "error",
        title:
          result.status === "success"
            ? source.kind === "email"
              ? "Email ready"
              : "Source connected"
            : result.status === "action-required"
              ? "Sign-in required"
              : "Connection check failed",
        description: sourceTestDescription(result),
      });
    } catch (cause) {
      void telemetry.capture({
        event: "source.connection.tested",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          outcome: "failed",
        },
      });
      toastManager.add({
        type: "error",
        title: "Connection check failed",
        description: message(cause),
      });
    } finally {
      setBusySourceId(null);
    }
  };

  const toggleSource = async (source: StudyBuddySourceBlock, enabled: boolean) => {
    const previous = inventory;
    onInventoryChange({
      ...inventory,
      sources: inventory.sources.map((item) =>
        item.id === source.id ? { ...item, enabled } : item,
      ),
    });
    setBusySourceId(source.id);
    try {
      const next = await ensureLocalApi().server.updateStudyBuddySource({
        expectedRevision: inventory.revision,
        sourceId: source.id,
        enabled,
      });
      onInventoryChange(next);
      void telemetry.capture({
        event: "source.changed",
        properties: {
          ...sourceTelemetryProperties({ ...source, enabled }, inventory),
          action: enabled ? "enabled" : "disabled",
          outcome: "success",
        },
      });
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("sources.management", {
          surface: "settings",
          action: enabled ? "enabled" : "disabled",
          source_kind: source.kind,
        }),
      });
    } catch (cause) {
      onInventoryChange(previous);
      void telemetry.capture({
        event: "source.changed",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          action: enabled ? "enabled" : "disabled",
          outcome: "failed",
        },
      });
      toastManager.add({
        type: "error",
        title: "Source wasn’t changed",
        description: message(cause),
      });
    } finally {
      setBusySourceId(null);
    }
  };

  const removeSource = async () => {
    if (!removingSource) return;
    setBusySourceId(removingSource.id);
    try {
      const next = await ensureLocalApi().server.deleteStudyBuddySource({
        expectedRevision: inventory.revision,
        sourceId: removingSource.id,
      });
      onInventoryChange(next);
      void telemetry.capture({
        event: "source.changed",
        properties: {
          ...sourceTelemetryProperties(removingSource, inventory),
          action: "deleted",
          outcome: "success",
        },
      });
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("sources.management", {
          surface: "settings",
          action: "deleted",
          source_kind: removingSource.kind,
        }),
      });
      setRemovingSourceId(null);
      toastManager.add({
        type: "success",
        title: "Source removed",
        description: `${removingSource.label} is no longer available to Study Buddy.`,
      });
    } catch (cause) {
      void telemetry.capture({
        event: "source.changed",
        properties: {
          ...sourceTelemetryProperties(removingSource, inventory),
          action: "deleted",
          outcome: "failed",
        },
      });
      toastManager.add({
        type: "error",
        title: "Source wasn’t removed",
        description: message(cause),
      });
    } finally {
      setBusySourceId(null);
    }
  };

  return (
    <>
      {orderedSources.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-full border border-primary/20 bg-primary/6 text-primary">
            <PlusIcon className="size-4" />
          </div>
          <h3 className="text-sm font-semibold">No sources yet</h3>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            Add Moodle, a calendar, a website, a resource portal, or email.
          </p>
          <Button
            className="mt-4"
            size="sm"
            data-analytics-id="sources.add"
            onClick={() => {
              setEditingSourceId(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon className="size-3.5" />
            Add source
          </Button>
        </div>
      ) : (
        <ul aria-label="Study Buddy sources" className="divide-y divide-border/60">
          {orderedSources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              connection={connections.get(source.connectionId)}
              testResult={testResults[source.id]}
              busy={busySourceId === source.id}
              onToggle={(enabled) => void toggleSource(source, enabled)}
              onTest={() => void testSource(source)}
              onReadEmail={() => setEmailSourceId(source.id)}
              onEdit={() => {
                setEditingSourceId(source.id);
                setDialogOpen(true);
              }}
              onRemove={() => setRemovingSourceId(source.id)}
            />
          ))}
        </ul>
      )}

      <SourceDialog
        open={dialogOpen}
        inventory={inventory}
        source={editingSource}
        connection={editingConnection}
        onOpenChange={(nextOpen) => {
          setDialogOpen(nextOpen);
          if (!nextOpen) setEditingSourceId(null);
        }}
        onSaved={(next, savedSourceId) => {
          onInventoryChange(next);
          const savedSource = next.sources.find((candidate) => candidate.id === savedSourceId);
          if (savedSource?.kind === "email" && savedSource.enabled) {
            void testSource(savedSource);
          }
        }}
      />

      <AlertDialog
        open={Boolean(removingSource)}
        onOpenChange={(open) => !open && setRemovingSourceId(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removingSource?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Study Buddy will stop using this source and remove its saved sign-in details.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={Boolean(busySourceId)}
              onClick={() => void removeSource()}
            >
              Remove source
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <EmailInboxDialog
        source={emailSource}
        inventory={inventory}
        open={Boolean(emailSource)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEmailSourceId(null);
        }}
      />
    </>
  );
}

function SourceRow({
  source,
  connection,
  testResult,
  busy,
  onToggle,
  onTest,
  onReadEmail,
  onEdit,
  onRemove,
}: {
  source: StudyBuddySourceBlock;
  connection: StudyBuddySourceConnection | undefined;
  testResult: StudyBuddySourceTestResult | undefined;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onReadEmail: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const item = SOURCE_KIND_PRESENTATION[source.kind];
  const Icon = item.icon;
  const emailReadReady =
    source.kind !== "email" ||
    source.health.status === "connected" ||
    connection?.emailProviderProfile?.readStateGuarantee === "verified-peek" ||
    (testResult?.status === "success" && testResult.code === "email-read-state-preserved");
  const emailReadAllowed =
    source.kind !== "email" ||
    (source.policy.authenticatedReads === "allowed" &&
      source.capabilities.includes("mail.message.read"));
  const status = busy
    ? source.kind === "email"
      ? "Checking email access…"
      : "Checking connection…"
    : testResult?.status === "failure"
      ? "Couldn't connect"
      : testResult?.status === "action-required"
        ? "Sign-in needed"
        : source.kind === "email"
          ? !emailReadAllowed
            ? "Email reading is off"
            : emailReadReady
              ? "Ready to read"
              : "Check first to enable mail"
          : testResult?.status === "success"
            ? "Connected"
            : healthLabel(source.health);
  const statusIsSuccess =
    testResult?.status === "success" || (source.kind === "email" && emailReadReady);
  const statusIsFailure = testResult?.status === "failure";
  const shownCapabilities = source.capabilities.slice(0, 2);

  return (
    <li className={cn("relative px-4 py-4 sm:px-5", !source.enabled && "opacity-65")}>
      <span className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-primary/70" aria-hidden />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/35 text-foreground/70">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{source.label}</h3>
              <span className="text-[11px] text-muted-foreground">{item.label}</span>
            </div>
            {connection ? (
              <p
                className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                title={connection.displayOrigin}
              >
                {connection.displayOrigin}
                {source.kind === "calendar" ? "" : connection.entryPath}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                aria-live="polite"
                className={cn(
                  "inline-flex items-center gap-1 text-[11px]",
                  statusIsSuccess
                    ? "text-success"
                    : statusIsFailure
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {statusIsSuccess ? (
                  <CheckCircle2Icon className="size-3" />
                ) : statusIsFailure ? (
                  <AlertCircleIcon className="size-3" />
                ) : null}
                {status}
              </span>
              {shownCapabilities.map((capability) => (
                <Badge key={capability} variant="secondary" size="sm">
                  {capabilityLabel(capability)}
                </Badge>
              ))}
              {source.kind === "email" && connection?.emailProviderProfile ? (
                <Badge variant="outline" size="sm">
                  {connection.emailProviderProfile.label}
                </Badge>
              ) : null}
              {source.capabilities.length > 2 ? (
                <Badge variant="outline" size="sm">
                  +{source.capabilities.length - 2}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Switch
            data-analytics-id="sources.toggle"
            checked={source.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={`Use ${source.label}`}
          />
          <Button
            data-analytics-id="sources.check"
            size="sm"
            variant="outline"
            disabled={busy || !source.enabled}
            onClick={onTest}
            aria-label={`Check ${source.label} connection`}
          >
            {busy ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            Check
          </Button>
          {source.kind === "email" ? (
            <Button
              data-analytics-id="email.inbox.open"
              size="sm"
              variant="outline"
              disabled={busy || !source.enabled || !emailReadReady || !emailReadAllowed}
              onClick={onReadEmail}
              aria-label={`Read ${source.label} without changing unread status`}
              title={
                !emailReadAllowed
                  ? "Allow email reading in this source's settings."
                  : emailReadReady
                    ? undefined
                    : "Select Check first."
              }
            >
              <MailIcon className="size-3.5" />
              Read mail
            </Button>
          ) : null}
          <Button
            data-analytics-id="sources.edit"
            size="icon-sm"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Edit ${source.label}`}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            data-analytics-id="sources.remove"
            size="icon-sm"
            variant="ghost"
            onClick={onRemove}
            aria-label={`Remove ${source.label}`}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "The source operation failed.";
}

function sourceTestDescription(result: StudyBuddySourceTestResult) {
  if (result.status === "success") return result.message;
  if (result.status === "action-required") return "Sign in to continue.";
  switch (result.code) {
    case "not-configured":
    case "credentials-not-configured":
      return "Add the missing sign-in details, then try again.";
    case "timeout":
      return "This source took too long to respond. Try again.";
    case "authentication-failed":
      return "The username or password was not accepted.";
    case "invalid-calendar":
      return "Study Buddy couldn’t read this calendar. Check the link and try again.";
    default:
      return "Study Buddy couldn’t connect. Check the address and try again.";
  }
}
