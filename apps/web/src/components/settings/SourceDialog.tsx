import type {
  StudyBuddyCreateSourceInput,
  StudyBuddyEmailProviderHint,
  StudyBuddySourceBlock,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
  StudyBuddySourceKind,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  FilePenLineIcon,
  MailOpenIcon,
  RadarIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { featureProperties } from "../../telemetry/featureCatalog";
import { telemetry } from "../../telemetry/runtime";
import { sourceTelemetryProperties } from "../../telemetry/sourceTelemetry";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { SecretInput } from "../ui/secret-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SOURCE_KIND_PRESENTATION } from "./sourcePresentation";
import {
  EMAIL_PROVIDER_OPTIONS,
  emailProviderOption,
  type EmailDiscovery,
  recognizeEmailProvider,
} from "./emailProviderPresentation";
import { isEmailAddress } from "./StudyBuddyEmailPermissions.logic";

type SourceDialogProps = {
  open: boolean;
  inventory: StudyBuddySourceInventory;
  source: StudyBuddySourceBlock | undefined;
  connection: StudyBuddySourceConnection | undefined;
  onOpenChange: (open: boolean) => void;
  onSaved: (inventory: StudyBuddySourceInventory, savedSourceId?: string) => void;
};

const SOURCE_KINDS = Object.keys(SOURCE_KIND_PRESENTATION) as StudyBuddySourceKind[];

export function SourceDialog({
  open,
  inventory,
  source,
  connection,
  onOpenChange,
  onSaved,
}: SourceDialogProps) {
  const [kind, setKind] = useState<StudyBuddySourceKind | null>(source?.kind ?? null);
  const [label, setLabel] = useState(source?.label ?? "");
  const [url, setUrl] = useState(
    source?.kind === "calendar"
      ? ""
      : connection
        ? `${connection.displayOrigin}${connection.entryPath}`
        : "",
  );
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [requiresSignIn, setRequiresSignIn] = useState(
    connection ? connection.auth.mode !== "none" : true,
  );
  const [username, setUsername] = useState(connection?.auth.accountLabel ?? "");
  const [password, setPassword] = useState("");
  const [emailProviderHint, setEmailProviderHint] = useState<StudyBuddyEmailProviderHint>(
    emailHintFromConnection(connection),
  );
  const [emailDiscovery, setEmailDiscovery] = useState<EmailDiscovery>({ status: "idle" });
  const [emailReadAllowed, setEmailReadAllowed] = useState(emailPermission(source, "read"));
  const [emailDraftAllowed, setEmailDraftAllowed] = useState(emailPermission(source, "draft"));
  const [emailSendAllowed, setEmailSendAllowed] = useState(emailPermission(source, "send"));
  const [senderEmail, setSenderEmail] = useState(accountEmailAddress(connection));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(source?.kind ?? null);
    setLabel(source?.label ?? "");
    setUrl(
      source?.kind === "calendar"
        ? ""
        : connection
          ? `${connection.displayOrigin}${connection.entryPath}`
          : "",
    );
    setEnabled(source?.enabled ?? true);
    setRequiresSignIn(connection ? connection.auth.mode !== "none" : true);
    setUsername(connection?.auth.accountLabel ?? "");
    setPassword("");
    setEmailProviderHint(emailHintFromConnection(connection));
    setEmailDiscovery({ status: "idle" });
    setEmailReadAllowed(emailPermission(source, "read"));
    setEmailDraftAllowed(emailPermission(source, "draft"));
    setEmailSendAllowed(emailPermission(source, "send"));
    setSenderEmail(accountEmailAddress(connection));
    setError(null);
  }, [connection, open, source]);

  const presentation = kind ? SOURCE_KIND_PRESENTATION[kind] : null;
  const isLegacy = source?.scope.tags.includes("legacy") ?? false;
  const urlError = useMemo(
    () => validateDisplayUrl(url, kind, Boolean(source)),
    [kind, source, url],
  );
  const emailSendingSupported =
    kind === "email" &&
    (connection?.adapterId === "sogo" ||
      connection?.adapterId === "roundcube" ||
      emailProviderHint === "sogo" ||
      emailProviderHint === "roundcube");

  useEffect(() => {
    if (!emailSendingSupported) setEmailSendAllowed(false);
  }, [emailSendingSupported]);

  useEffect(() => {
    if (!open || kind !== "email" || !url.trim()) {
      setEmailDiscovery({ status: "idle" });
      return;
    }
    const parsedProtocol = safeProtocol(url);
    if (parsedProtocol === "imaps:") {
      setEmailDiscovery(recognizeEmailProvider(emailProviderHint, url));
      return;
    }
    setEmailDiscovery({ status: "probing" });
    const timer = window.setTimeout(() => {
      setEmailDiscovery(recognizeEmailProvider(emailProviderHint, url));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [emailProviderHint, kind, open, url]);

  const save = async () => {
    if (!kind) return;
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Give this source a name.");
      return;
    }
    if (urlError) {
      setError(urlError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let next: StudyBuddySourceInventory;
      if (source) {
        next = await ensureLocalApi().server.updateStudyBuddySource({
          expectedRevision: inventory.revision,
          sourceId: source.id,
          label: trimmedLabel,
          ...(kind === "calendar" || !url.trim() ? {} : { url: url.trim() }),
          ...(kind === "email" ? { emailProviderHint } : {}),
          enabled,
        });
        if (kind === "calendar" && url.trim()) {
          next = await ensureLocalApi().server.setStudyBuddySourceAuth({
            operation: "set-bearer-url",
            expectedRevision: next.revision,
            sourceId: source.id,
            value: url.trim(),
          });
        } else if (password) {
          next = await ensureLocalApi().server.setStudyBuddySourceAuth({
            operation: "set-password",
            expectedRevision: next.revision,
            sourceId: source.id,
            username: username.trim(),
            password,
            ...(kind === "email" && isEmailAddress(senderEmail || username)
              ? { emailAddress: (senderEmail || username).trim() }
              : {}),
          });
        }
      } else {
        next = await ensureLocalApi().server.createStudyBuddySource(
          createInput({
            inventory,
            kind,
            label: trimmedLabel,
            url: url.trim(),
            enabled,
            requiresSignIn,
            username: username.trim(),
            password,
            senderEmail: senderEmail.trim(),
            emailProviderHint,
          }),
        );
      }
      const createdSourceId = source
        ? source.id
        : next.sources.find(
            (candidate) => !inventory.sources.some((old) => old.id === candidate.id),
          )?.id;
      if (kind === "email" && createdSourceId) {
        next = await ensureLocalApi().server.updateStudyBuddyEmailPermissions({
          expectedRevision: next.revision,
          sourceId: createdSourceId,
          read: emailReadAllowed,
          draft: emailDraftAllowed,
          send: emailSendAllowed,
          senderEmail: senderEmail.trim() || (isEmailAddress(username) ? username.trim() : null),
        });
      }
      const savedSource = createdSourceId
        ? next.sources.find((candidate) => candidate.id === createdSourceId)
        : undefined;
      if (savedSource) {
        void telemetry.capture({
          event: "source.changed",
          properties: {
            ...sourceTelemetryProperties(savedSource, next),
            action: source ? "updated" : "created",
            outcome: "success",
          },
        });
        void telemetry.capture({
          event: "feature.used",
          properties: featureProperties("sources.management", {
            surface: "source_dialog",
            action: source ? "updated" : "created",
            source_kind: savedSource.kind,
          }),
        });
        if (kind === "email") {
          const previousPermissions = {
            read: emailPermission(source, "read"),
            draft: emailPermission(source, "draft"),
            send: emailPermission(source, "send"),
          };
          for (const [permission, enabledNow] of Object.entries({
            read: emailReadAllowed,
            draft: emailDraftAllowed,
            send: emailSendAllowed,
          })) {
            if (
              previousPermissions[permission as keyof typeof previousPermissions] === enabledNow
            ) {
              continue;
            }
            void telemetry.capture({
              event: "email.permission.changed",
              properties: {
                ...sourceTelemetryProperties(savedSource, next),
                permission,
                enabled: enabledNow,
                sender_configured: Boolean(senderEmail.trim()),
                surface: "source_dialog",
                outcome: "success",
              },
            });
          }
          void telemetry.capture({
            event: "feature.used",
            properties: featureProperties("email.permissions", {
              surface: "source_dialog",
            }),
          });
        }
      }
      onSaved(next, createdSourceId);
      onOpenChange(false);
      toastManager.add({
        type: "success",
        title: source ? "Source updated" : "Source added",
        description: `${trimmedLabel} can now be used by Study Buddy.`,
      });
    } catch (cause) {
      void telemetry.capture({
        event: "source.changed",
        properties: {
          source_kind: kind,
          action: source ? "updated" : "created",
          outcome: "failed",
        },
      });
      setError(cause instanceof Error ? cause.message : "We couldn’t save this source.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {source ? "Edit source" : kind ? `Add ${presentation?.label}` : "Add source"}
          </DialogTitle>
          <DialogDescription>
            {source
              ? "Update this source. Saved passwords and private links stay hidden."
              : kind
                ? presentation?.description
                : "Choose where Study Buddy should look for information."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel key={kind ?? "source-types"} className="space-y-5">
          {error ? (
            <Alert variant="error" role="alert">
              <AlertTitle>We couldn’t save this source</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {!kind ? (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              role="radiogroup"
              aria-label="Source type"
            >
              {SOURCE_KINDS.map((candidate) => {
                const item = SOURCE_KIND_PRESENTATION[candidate];
                const Icon = item.icon;
                return (
                  <button
                    key={candidate}
                    type="button"
                    data-analytics-id={`sources.type.${candidate}`}
                    role="radio"
                    aria-checked="false"
                    className="group flex min-h-28 items-start gap-3 rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:border-primary/45 hover:bg-primary/4 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setKind(candidate);
                      setLabel(defaultLabel(candidate));
                      setRequiresSignIn(candidate !== "website" && candidate !== "resource-portal");
                    }}
                  >
                    <span className="mt-0.5 rounded-lg bg-primary/8 p-2 text-primary">
                      <Icon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{item.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {!source ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit"
                  onClick={() => setKind(null)}
                >
                  <ArrowLeftIcon className="size-3.5" />
                  Choose another type
                </Button>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field className={kind === "email" ? undefined : "sm:col-span-2"}>
                  <FieldLabel>Name in Study Buddy</FieldLabel>
                  <Input
                    nativeInput
                    aria-label="Name in Study Buddy"
                    value={label}
                    onChange={(event) => setLabel(event.currentTarget.value)}
                    placeholder={defaultLabel(kind)}
                  />
                </Field>

                {kind === "email" ? (
                  <Field>
                    <FieldLabel>Email service</FieldLabel>
                    <Select
                      value={emailProviderHint}
                      onValueChange={(value) => {
                        if (!value) return;
                        const hint = value as StudyBuddyEmailProviderHint;
                        setEmailProviderHint(hint);
                        const preset = emailProviderOption(hint).presetUrl;
                        if (preset) setUrl(preset);
                      }}
                    >
                      <SelectTrigger aria-label="Email service">
                        <SelectValue>{emailProviderOption(emailProviderHint).label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {EMAIL_PROVIDER_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {emailProviderOption(emailProviderHint).description}
                    </FieldDescription>
                  </Field>
                ) : null}

                <Field className="sm:col-span-2">
                  <FieldLabel>{urlLabel(kind)}</FieldLabel>
                  {kind === "calendar" ? (
                    <SecretInput
                      label="Private calendar link"
                      placeholder={
                        source ? "Private link saved — enter to replace" : "https://…/calendar.ics"
                      }
                      onValueChange={setUrl}
                      autoComplete="url"
                    />
                  ) : (
                    <Input
                      nativeInput
                      aria-label={urlLabel(kind)}
                      value={url}
                      onChange={(event) => setUrl(event.currentTarget.value)}
                      placeholder={urlPlaceholder(kind)}
                      autoComplete="url"
                    />
                  )}
                  <FieldDescription>
                    {kind === "calendar"
                      ? "This link stays private. Study Buddy only uses it to read your calendar."
                      : kind === "email"
                        ? "Paste the website you use for email. If your university gave you an IMAP server instead, enter it here."
                        : "Study Buddy only reads pages on this website."}
                  </FieldDescription>
                </Field>

                {kind === "email" ? <EmailDiscoveryStatus discovery={emailDiscovery} /> : null}

                {(kind === "website" || kind === "resource-portal") && !source ? (
                  <div className="flex items-center justify-between gap-4 rounded-xl border p-3 sm:col-span-2">
                    <div>
                      <p className="text-sm font-medium">Requires sign-in</p>
                      <p className="text-xs text-muted-foreground">
                        Turn this on if the website asks for a username and password.
                      </p>
                    </div>
                    <Switch
                      checked={requiresSignIn}
                      onCheckedChange={setRequiresSignIn}
                      aria-label="Source requires sign-in"
                    />
                  </div>
                ) : null}

                {kind !== "calendar" &&
                (requiresSignIn || kind === "moodle-course" || kind === "email") ? (
                  <>
                    <Field>
                      <FieldLabel>
                        {kind === "email" ? "Email address or username" : "Username"}
                      </FieldLabel>
                      <Input
                        nativeInput
                        aria-label={kind === "email" ? "Email address or username" : "Username"}
                        value={username}
                        onChange={(event) => {
                          const nextUsername = event.currentTarget.value;
                          setUsername(nextUsername);
                          if (kind === "email" && !senderEmail && isEmailAddress(nextUsername)) {
                            setSenderEmail(nextUsername.trim());
                          }
                        }}
                        autoComplete="username"
                        placeholder={
                          kind === "email" ? "student@university.example" : "Student username"
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Password</FieldLabel>
                      <SecretInput
                        label="Password"
                        placeholder={
                          connection?.auth.state === "configured"
                            ? "Password saved — enter to replace"
                            : "Enter password"
                        }
                        onValueChange={setPassword}
                      />
                    </Field>
                  </>
                ) : null}

                {kind === "email" ? (
                  <div className="overflow-hidden rounded-xl border sm:col-span-2">
                    <EmailPermissionRow
                      icon={MailOpenIcon}
                      title="Read email"
                      description="Study Buddy may search and use messages as context. Unread messages stay unread."
                      checked={emailReadAllowed}
                      onCheckedChange={setEmailReadAllowed}
                    />
                    <EmailPermissionRow
                      icon={FilePenLineIcon}
                      title="Prepare drafts"
                      description="Study Buddy may write a proposed email in chat. Nothing is saved or sent yet."
                      checked={emailDraftAllowed}
                      onCheckedChange={(checked) => {
                        setEmailDraftAllowed(checked);
                        if (!checked) setEmailSendAllowed(false);
                      }}
                    />
                    <EmailPermissionRow
                      icon={SendIcon}
                      title="Ask to send"
                      description="Every email needs a new approval showing its exact recipients and message."
                      checked={emailSendAllowed}
                      disabled={!emailSendingSupported}
                      onCheckedChange={(checked) => {
                        setEmailSendAllowed(checked);
                        if (checked) setEmailDraftAllowed(true);
                      }}
                    />
                    {!emailSendingSupported ? (
                      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                        Sending is not available for this email service yet. Reading and drafts
                        still work.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {kind === "email" && emailSendAllowed ? (
                  <Field className="sm:col-span-2">
                    <FieldLabel>Email address used to send</FieldLabel>
                    <Input
                      nativeInput
                      type="email"
                      aria-label="Email address used to send"
                      value={senderEmail}
                      onChange={(event) => setSenderEmail(event.currentTarget.value)}
                      placeholder="student@university.example"
                      autoComplete="email"
                    />
                    <FieldDescription>
                      This address appears in the approval card and must match the connected
                      account.
                    </FieldDescription>
                  </Field>
                ) : null}

                {kind === "email" ? (
                  <Alert className="sm:col-span-2">
                    <ShieldCheckIcon />
                    <AlertTitle>Mailbox changes stay off</AlertTitle>
                    <AlertDescription>
                      Study Buddy cannot delete, move, archive, or mark messages as read. Sending is
                      possible only after you approve the exact email in chat.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {isLegacy ? (
                  <Alert className="sm:col-span-2">
                    <CheckCircle2Icon />
                    <AlertTitle>Saved sign-in</AlertTitle>
                    <AlertDescription>
                      Study Buddy will keep using the sign-in details you already saved.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex items-center justify-between gap-4 rounded-xl border p-3 sm:col-span-2">
                  <div>
                    <p className="text-sm font-medium">Use this source</p>
                    <p className="text-xs text-muted-foreground">
                      Turn this off to keep the source saved without using it.
                    </p>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={setEnabled}
                    aria-label={`Use ${label || presentation?.label}`}
                  />
                </div>
              </div>
            </>
          )}
        </DialogPanel>
        {kind ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button data-analytics-id="sources.save" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : source ? "Save changes" : "Add source"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function EmailPermissionRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  icon: typeof MailOpenIcon;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b p-3 last:border-b-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={title}
      />
    </div>
  );
}

function emailPermission(
  source: StudyBuddySourceBlock | undefined,
  permission: "read" | "draft" | "send",
) {
  if (!source || source.kind !== "email") return permission === "read";
  if (permission === "read") {
    return (
      source.policy.authenticatedReads === "allowed" &&
      source.capabilities.includes("mail.message.read")
    );
  }
  if (permission === "draft") {
    return (
      source.policy.remoteDrafts === "allowed" && source.capabilities.includes("mail.draft.local")
    );
  }
  return (
    source.policy.emailSend === "approval-required" && source.capabilities.includes("mail.send")
  );
}

function createInput(input: {
  inventory: StudyBuddySourceInventory;
  kind: StudyBuddySourceKind;
  label: string;
  url: string;
  enabled: boolean;
  requiresSignIn: boolean;
  username: string;
  password: string;
  senderEmail: string;
  emailProviderHint: StudyBuddyEmailProviderHint;
}): StudyBuddyCreateSourceInput {
  const auth =
    input.kind === "calendar"
      ? ({ operation: "set-bearer-url", value: input.url } as const)
      : input.requiresSignIn || input.kind === "moodle-course" || input.kind === "email"
        ? ({
            operation: "set-password",
            username: input.username,
            password: input.password,
            ...(input.kind === "email" && isEmailAddress(input.senderEmail || input.username)
              ? { emailAddress: input.senderEmail || input.username }
              : {}),
          } as const)
        : ({ operation: "set-none" } as const);
  return {
    expectedRevision: input.inventory.revision,
    kind: input.kind,
    label: input.label,
    url: input.url,
    enabled: input.enabled,
    ...(input.kind === "email" ? { emailProviderHint: input.emailProviderHint } : {}),
    auth,
  };
}

function validateDisplayUrl(
  value: string,
  kind: StudyBuddySourceKind | null,
  allowSavedValue = false,
): string | null {
  if (!kind) return null;
  if (!value.trim()) {
    if (allowSavedValue) return null;
    return kind === "calendar" ? "Enter the private calendar link." : "Enter the source website.";
  }
  try {
    const parsed = new URL(value.trim().replace(/^webcal:\/\//i, "https://"));
    if (kind === "email") {
      if (parsed.protocol !== "imaps:" && parsed.protocol !== "https:")
        return "Enter a website that starts with https:// or an email server that starts with imaps://.";
      if (parsed.username || parsed.password)
        return "Remove the sign-in details from this address. Enter them in the fields below.";
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      return "Use an HTTPS address.";
    if (parsed.username || parsed.password)
      return "Remove the sign-in details from this address. Enter them in the fields below.";
  } catch {
    return kind === "email"
      ? "Enter the full email website or server address."
      : "Enter the full website address, including https://.";
  }
  return null;
}

function defaultLabel(kind: StudyBuddySourceKind) {
  return kind === "email" ? "University email" : SOURCE_KIND_PRESENTATION[kind].label;
}

function accountEmailAddress(connection: StudyBuddySourceConnection | undefined): string {
  if (connection?.auth.emailAddress) return connection.auth.emailAddress;
  const account = connection?.auth.accountLabel?.trim() ?? "";
  return isEmailAddress(account) ? account : "";
}

function urlLabel(kind: StudyBuddySourceKind) {
  if (kind === "calendar") return "Private calendar link";
  if (kind === "email") return "Email website or server";
  if (kind === "moodle-course") return "Moodle website or course link";
  return "Website address";
}

function urlPlaceholder(kind: StudyBuddySourceKind) {
  if (kind === "email") return "https://mail.university.example or imaps://imap.example:993";
  if (kind === "moodle-course") return "https://moodle.university.example/course/view.php?id=…";
  return "https://portal.university.example/resources";
}

function safeProtocol(value: string) {
  try {
    return new URL(value.trim()).protocol;
  } catch {
    return "";
  }
}

function emailHintFromConnection(
  connection: StudyBuddySourceConnection | undefined,
): StudyBuddyEmailProviderHint {
  const id = connection?.emailProviderProfile?.id;
  return EMAIL_PROVIDER_OPTIONS.some((option) => option.value === id)
    ? (id as StudyBuddyEmailProviderHint)
    : "auto-detect";
}

function EmailDiscoveryStatus({ discovery }: { discovery: EmailDiscovery }) {
  return (
    <div
      className="relative overflow-hidden rounded-xl border bg-muted/20 p-3 sm:col-span-2"
      aria-live="polite"
    >
      <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary/70" aria-hidden />
      <div className="flex items-start gap-2.5">
        {discovery.status === "probing" ? (
          <Spinner className="mt-0.5 size-4 text-primary" />
        ) : discovery.status === "recognized" ? (
          <RadarIcon className="mt-0.5 size-4 text-primary" />
        ) : discovery.status === "manual" ? (
          <CircleHelpIcon className="mt-0.5 size-4 text-muted-foreground" />
        ) : (
          <SearchIcon className="mt-0.5 size-4 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {discovery.status === "probing"
              ? "Checking the email service…"
              : discovery.status === "recognized"
                ? `We found ${discovery.label}`
                : discovery.status === "manual"
                  ? "We’ll check this service after you save"
                  : "Study Buddy will recognize the service"}
          </p>
          {discovery.status === "idle" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Enter the address above to begin.
            </p>
          ) : discovery.status === "recognized" || discovery.status === "manual" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{discovery.detail}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
