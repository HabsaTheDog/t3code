import type {
  StudyBuddySourceBlock,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
} from "@t3tools/contracts";
import { FilePenLineIcon, MailOpenIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { featureProperties } from "../../telemetry/featureCatalog";
import { telemetry } from "../../telemetry/runtime";
import { sourceTelemetryProperties } from "../../telemetry/sourceTelemetry";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  emailPermissionState,
  isEmailAddress,
  optimisticEmailPermissionInventory,
  type StudyBuddyEmailPermissionState,
} from "./StudyBuddyEmailPermissions.logic";

export function EmailPermissionControls({
  inventory,
  onInventoryChange,
  surface = "settings",
}: {
  inventory: StudyBuddySourceInventory;
  onInventoryChange: (inventory: StudyBuddySourceInventory) => void;
  surface?: "settings" | "composer";
}) {
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const connections = useMemo(
    () => new Map(inventory.connections.map((connection) => [connection.id, connection])),
    [inventory.connections],
  );
  const emailSources = useMemo(
    () =>
      inventory.sources
        .filter((source) => source.kind === "email")
        .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label)),
    [inventory.sources],
  );

  if (emailSources.length === 0) {
    return (
      <div className={cn("text-sm text-muted-foreground", surface === "settings" && "px-5 py-5")}>
        Add an email source first. Its permissions will appear here and in every chat.
      </div>
    );
  }

  const savePermissions = async (
    source: StudyBuddySourceBlock,
    next: Pick<StudyBuddyEmailPermissionState, "read" | "draft" | "send" | "senderEmail">,
  ) => {
    const senderEmail = next.senderEmail.trim();
    if ((next.send || senderEmail) && !isEmailAddress(senderEmail)) {
      setErrors((current) => ({
        ...current,
        [source.id]: next.send
          ? "Add the email address this account sends from before allowing send requests."
          : "Enter a complete email address, such as student@university.example.",
      }));
      return;
    }

    const previous = inventory;
    const optimistic = optimisticEmailPermissionInventory(inventory, source.id, {
      ...next,
      senderEmail,
    });
    setBusySourceId(source.id);
    setErrors((current) => ({ ...current, [source.id]: "" }));
    onInventoryChange(optimistic);
    try {
      const updated = await ensureLocalApi().server.updateStudyBuddyEmailPermissions({
        expectedRevision: inventory.revision,
        sourceId: source.id,
        read: next.read,
        draft: next.draft,
        send: next.send,
        senderEmail: senderEmail || null,
      });
      onInventoryChange(updated);
      const updatedSource =
        updated.sources.find((candidate) => candidate.id === source.id) ?? source;
      for (const permission of ["read", "draft", "send"] as const) {
        if (
          next[permission] ===
          emailPermissionState(source, connections.get(source.connectionId))[permission]
        ) {
          continue;
        }
        void telemetry.capture({
          event: "email.permission.changed",
          properties: {
            ...sourceTelemetryProperties(updatedSource, updated),
            permission,
            enabled: next[permission],
            sender_configured: Boolean(senderEmail),
            surface,
            outcome: "success",
          },
        });
      }
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("email.permissions", { surface }),
      });
    } catch (cause) {
      onInventoryChange(previous);
      void telemetry.capture({
        event: "email.permission.changed",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          permission: "configuration",
          surface,
          outcome: "failed",
        },
      });
      const message =
        cause instanceof Error ? cause.message : "Study Buddy couldn’t save this email permission.";
      setErrors((current) => ({ ...current, [source.id]: message }));
      toastManager.add({
        type: "error",
        title: "Email access wasn’t saved",
        description: message,
      });
    } finally {
      setBusySourceId(null);
    }
  };

  return (
    <div className={cn(surface === "composer" && "space-y-3")}>
      {emailSources.map((source) => {
        const connection = connections.get(source.connectionId);
        const permissions = emailPermissionState(source, connection);
        const busy = busySourceId === source.id;
        return (
          <EmailPermissionAccount
            key={source.id}
            source={source}
            connection={connection}
            permissions={permissions}
            busy={busy}
            error={errors[source.id]}
            surface={surface}
            onChange={(next) => void savePermissions(source, next)}
          />
        );
      })}
    </div>
  );
}

function EmailPermissionAccount({
  source,
  connection,
  permissions,
  busy,
  error,
  surface,
  onChange,
}: {
  source: StudyBuddySourceBlock;
  connection: StudyBuddySourceConnection | undefined;
  permissions: StudyBuddyEmailPermissionState;
  busy: boolean;
  error: string | undefined;
  surface: "settings" | "composer";
  onChange: (permissions: StudyBuddyEmailPermissionState) => void;
}) {
  const [senderDraft, setSenderDraft] = useState(permissions.senderEmail);

  useEffect(() => {
    setSenderDraft(permissions.senderEmail);
  }, [permissions.senderEmail]);

  const permissionLabel = (name: string) => `${name} for ${source.label}`;

  return (
    <section
      aria-label={`${source.label} email permissions`}
      className={cn(
        surface === "settings"
          ? "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5"
          : "rounded-xl border bg-background/40 p-3",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold">{source.label}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {connection?.displayOrigin ?? "Email account"}
          </p>
        </div>
        {busy ? (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
            aria-live="polite"
          >
            <Spinner className="size-3" /> Saving…
          </span>
        ) : null}
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border">
        <PermissionToggle
          icon={MailOpenIcon}
          title="Read email"
          description="Use messages as context. Unread messages stay unread."
          checked={permissions.read}
          disabled={busy}
          ariaLabel={permissionLabel("Read email")}
          analyticsId="email.permission.read"
          onCheckedChange={(read) => onChange({ ...permissions, read })}
        />
        <PermissionToggle
          icon={FilePenLineIcon}
          title="Prepare drafts"
          description="Write an email in chat without saving or sending it."
          checked={permissions.draft}
          disabled={busy}
          ariaLabel={permissionLabel("Prepare drafts")}
          analyticsId="email.permission.draft"
          onCheckedChange={(draft) =>
            onChange({ ...permissions, draft, send: draft ? permissions.send : false })
          }
        />
        <PermissionToggle
          icon={SendIcon}
          title="Ask to send"
          description="Show the complete email in chat and ask once before sending."
          checked={permissions.send}
          disabled={busy || !permissions.sendingSupported}
          ariaLabel={permissionLabel("Ask to send")}
          analyticsId="email.permission.send"
          onCheckedChange={(send) =>
            onChange({
              ...permissions,
              draft: send ? true : permissions.draft,
              send,
              senderEmail: senderDraft,
            })
          }
        />
      </div>

      {permissions.sendingSupported ? (
        <div className="mt-3">
          <label
            htmlFor={`email-sender-${source.id}`}
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            Sending address
          </label>
          <Input
            nativeInput
            id={`email-sender-${source.id}`}
            type="email"
            value={senderDraft}
            onChange={(event) => setSenderDraft(event.currentTarget.value)}
            onBlur={() => {
              if (!permissions.send) return;
              if (senderDraft === permissions.senderEmail) return;
              onChange({ ...permissions, senderEmail: senderDraft });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder="student@university.example"
            autoComplete="email"
            disabled={busy}
            aria-describedby={`email-sender-help-${source.id}`}
          />
          <p
            id={`email-sender-help-${source.id}`}
            className="mt-1.5 text-[11px] text-muted-foreground"
          >
            {permissions.senderEmail
              ? "Using the email address saved with this account. Change it here only if needed."
              : "This account is connected. Run Check to load its sending address, or enter the address here."}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          This email service supports reading and writing in chat, but not sending yet.
        </p>
      )}

      {!source.enabled ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          This source is currently off, so Study Buddy will not use it.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function PermissionToggle({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  ariaLabel,
  analyticsId,
  onCheckedChange,
}: {
  icon: typeof MailOpenIcon;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  analyticsId: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch
        data-analytics-id={analyticsId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
      />
    </div>
  );
}
