import type {
  StudyBuddyEmailMessageSummary,
  StudyBuddyReadEmailMessageResult,
  StudyBuddySourceBlock,
  StudyBuddySourceInventory,
} from "@t3tools/contracts";
import { MailIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { featureProperties } from "../../telemetry/featureCatalog";
import { telemetry } from "../../telemetry/runtime";
import { sourceTelemetryProperties, telemetryCountBucket } from "../../telemetry/sourceTelemetry";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export function EmailInboxDialog({
  source,
  inventory,
  open,
  onOpenChange,
}: {
  source: StudyBuddySourceBlock | undefined;
  inventory: StudyBuddySourceInventory;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<readonly StudyBuddyEmailMessageSummary[]>([]);
  const [selected, setSelected] = useState<StudyBuddyReadEmailMessageResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMessages = useCallback(
    async (searchQuery?: string) => {
      if (!source) return;
      const operation = searchQuery?.trim() ? "search" : "list";
      setLoadingList(true);
      setError(null);
      setSelected(null);
      try {
        const result = searchQuery?.trim()
          ? await ensureLocalApi().server.searchStudyBuddyEmailMessages({
              sourceId: source.id,
              folder: "INBOX",
              query: searchQuery.trim(),
              limit: 25,
            })
          : await ensureLocalApi().server.listStudyBuddyEmailMessages({
              sourceId: source.id,
              folder: "INBOX",
              limit: 25,
            });
        setMessages(result.messages);
        void telemetry.capture({
          event: "email.inbox.loaded",
          properties: {
            ...sourceTelemetryProperties(source, inventory),
            operation,
            outcome: "success",
            result_count: telemetryCountBucket(result.messages.length),
          },
        });
      } catch (cause) {
        setMessages([]);
        setError(message(cause));
        void telemetry.capture({
          event: "email.inbox.loaded",
          properties: {
            ...sourceTelemetryProperties(source, inventory),
            operation,
            outcome: "failed",
          },
        });
      } finally {
        setLoadingList(false);
      }
    },
    [inventory, source],
  );

  useEffect(() => {
    if (!open || !source) return;
    setQuery("");
    void telemetry.capture({
      event: "feature.used",
      properties: featureProperties("email.inbox", { surface: "settings" }),
    });
    void loadMessages();
  }, [loadMessages, open, source]);

  const readMessage = async (summary: StudyBuddyEmailMessageSummary) => {
    if (!source) return;
    setLoadingMessageId(summary.messageId);
    setError(null);
    try {
      const result = await ensureLocalApi().server.readStudyBuddyEmailMessage({
        sourceId: source.id,
        folder: summary.folder,
        messageId: summary.messageId,
      });
      setSelected(result);
      const seenStatePreserved =
        result.seenState.preserved && result.seenState.seenBefore === result.seenState.seenAfter;
      void telemetry.capture({
        event: "email.message.opened",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          outcome: seenStatePreserved ? "opened" : "blocked",
          was_unread: !summary.isSeen,
          has_attachments: summary.hasAttachments,
          body_truncated: result.body.truncated,
        },
      });
      if (
        !result.seenState.preserved ||
        result.seenState.seenBefore !== result.seenState.seenAfter
      ) {
        setError(
          "Study Buddy could not keep this message’s read status unchanged, so it stopped before showing the content.",
        );
      }
    } catch (cause) {
      setError(message(cause));
      void telemetry.capture({
        event: "email.message.opened",
        properties: {
          ...sourceTelemetryProperties(source, inventory),
          outcome: "failed",
          was_unread: !summary.isSeen,
          has_attachments: summary.hasAttachments,
        },
      });
    } finally {
      setLoadingMessageId(null);
    }
  };

  const seenStatePreserved =
    selected?.seenState.preserved && selected.seenState.seenBefore === selected.seenState.seenAfter;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{source ? `${source.label} inbox` : "Email inbox"}</DialogTitle>
          <DialogDescription>Read messages here without marking them as read.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadMessages(query);
            }}
          >
            <Input
              nativeInput
              aria-label="Search email"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search subject, sender, or message text"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={loadingList}
              data-analytics-id="email.inbox.search"
            >
              {loadingList ? <Spinner className="size-3.5" /> : <SearchIcon className="size-3.5" />}
              Search
            </Button>
          </form>

          <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/5 px-3 py-2 text-xs text-success-foreground">
            <ShieldCheckIcon className="size-3.5" />
            Viewing only · messages keep their read or unread status
          </div>

          {error ? (
            <Alert variant="error" role="alert">
              <AlertTitle>This message wasn’t opened</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid min-h-80 overflow-hidden rounded-xl border md:grid-cols-[minmax(16rem,0.9fr)_minmax(20rem,1.35fr)]">
            <div className="max-h-[28rem] overflow-y-auto border-b md:border-r md:border-b-0">
              {loadingList ? (
                <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
                  <Spinner className="size-4" /> Loading inbox…
                </div>
              ) : messages.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  No matching messages.
                </div>
              ) : (
                <ul aria-label="Email messages" className="divide-y divide-border/60">
                  {messages.map((summary) => (
                    <li key={`${summary.folder}:${summary.messageId}`}>
                      <button
                        type="button"
                        data-analytics-id="email.inbox.message"
                        className="w-full px-4 py-3 text-left outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => void readMessage(summary)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="line-clamp-1 text-sm font-semibold">
                            {summary.subject || "(No subject)"}
                          </span>
                          {!summary.isSeen ? (
                            <Badge size="sm" variant="info">
                              Unread
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                          {formatAddresses(summary.from)}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground/80">
                          {summary.sanitizedPreview}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="max-h-[28rem] overflow-y-auto p-5">
              {loadingMessageId ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-4" /> Opening message safely…
                </div>
              ) : selected && seenStatePreserved ? (
                <article>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="success">
                      <ShieldCheckIcon />
                      {selected.seenState.seenBefore ? "Read status unchanged" : "Still unread"}
                    </Badge>
                    {selected.body.truncated ? (
                      <Badge variant="warning">Content shortened</Badge>
                    ) : null}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold tracking-tight">
                    {selected.message.subject || "(No subject)"}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    From {formatAddresses(selected.message.from)}
                  </p>
                  <pre className="mt-5 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
                    {selected.body.sanitizedText}
                  </pre>
                </article>
              ) : (
                <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
                  <MailIcon className="size-6 opacity-50" />
                  <p className="mt-2 text-sm font-medium">Choose a message</p>
                  <p className="mt-1 max-w-xs text-xs">
                    Study Buddy will show it here without changing its read status.
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            data-analytics-id="email.inbox.close"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function formatAddresses(
  addresses: readonly { readonly name?: string; readonly address: string }[],
) {
  return addresses.map((entry) => entry.name || entry.address).join(", ") || "Unknown sender";
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Study Buddy couldn’t open this mailbox.";
}
