import { CheckIcon, SendIcon, ThumbsDownIcon, ThumbsUpIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { telemetry } from "../../telemetry/runtime";
import {
  MAX_RESPONSE_FEEDBACK_LENGTH,
  type ResponseFeedbackCaptureResult,
  type ResponseFeedbackInput,
  type ResponseFeedbackRating,
} from "../../telemetry/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface StoredResponseFeedback {
  readonly rating: ResponseFeedbackRating;
  readonly note: string;
}

const submitTelemetryFeedback = (feedback: ResponseFeedbackInput) =>
  telemetry.submitResponseFeedback(feedback);

function storageKey(threadId: string, turnId: string) {
  return `study-buddy:response-feedback:${threadId}:${turnId}`;
}

function readStoredFeedback(threadId: string, turnId: string): StoredResponseFeedback | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(threadId, turnId)) ?? "null",
    ) as Partial<StoredResponseFeedback> | null;
    if (parsed?.rating !== "positive" && parsed?.rating !== "negative") return null;
    return { rating: parsed.rating, note: typeof parsed.note === "string" ? parsed.note : "" };
  } catch {
    return null;
  }
}

function writeStoredFeedback(threadId: string, turnId: string, value: StoredResponseFeedback) {
  try {
    window.localStorage.setItem(storageKey(threadId, turnId), JSON.stringify(value));
  } catch {
    // Feedback remains usable for this mounted response when local storage is unavailable.
  }
}

export function AssistantResponseFeedback({
  threadId,
  turnId,
  submitFeedback = submitTelemetryFeedback,
}: {
  readonly threadId: string;
  readonly turnId: string;
  readonly submitFeedback?: (
    feedback: ResponseFeedbackInput,
  ) => Promise<ResponseFeedbackCaptureResult>;
}) {
  const initial = readStoredFeedback(threadId, turnId);
  const [rating, setRating] = useState<ResponseFeedbackRating | null>(initial?.rating ?? null);
  const [note, setNote] = useState(initial?.note ?? "");
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<"idle" | "sent" | "local">("idle");
  const [confirmationPhase, setConfirmationPhase] = useState<
    "hidden" | "entering" | "visible" | "leaving"
  >("hidden");
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmationTimerRef = useRef<number | null>(null);
  const confirmationFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmationTimerRef.current !== null) {
        window.clearTimeout(confirmationTimerRef.current);
      }
      if (confirmationFrameRef.current !== null) {
        window.cancelAnimationFrame(confirmationFrameRef.current);
      }
    },
    [],
  );

  const clearConfirmation = () => {
    if (confirmationTimerRef.current !== null) {
      window.clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
    }
    if (confirmationFrameRef.current !== null) {
      window.cancelAnimationFrame(confirmationFrameRef.current);
      confirmationFrameRef.current = null;
    }
    setConfirmationPhase("hidden");
  };

  const showSentConfirmation = () => {
    clearConfirmation();
    setConfirmationPhase("entering");
    confirmationFrameRef.current = window.requestAnimationFrame(() => {
      setConfirmationPhase("visible");
      confirmationFrameRef.current = null;
    });
    confirmationTimerRef.current = window.setTimeout(() => {
      setConfirmationPhase("leaving");
      confirmationTimerRef.current = window.setTimeout(() => {
        setConfirmationPhase("hidden");
        confirmationTimerRef.current = null;
      }, 220);
    }, 2_000);
  };

  const resizeNoteField = (element: HTMLTextAreaElement) => {
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 136)}px`;
  };

  const chooseRating = async (nextRating: ResponseFeedbackRating) => {
    clearConfirmation();
    const next = { rating: nextRating, note } satisfies StoredResponseFeedback;
    setRating(nextRating);
    setExpanded(true);
    setDelivery("idle");
    writeStoredFeedback(threadId, turnId, next);
    const result = await submitFeedback({ threadId, turnId, rating: nextRating });
    setDelivery(result.ratingCaptured ? "sent" : "local");
  };

  const submitNote = async () => {
    if (!rating) return;
    const trimmedNote = note.trim();
    writeStoredFeedback(threadId, turnId, { rating, note: trimmedNote });
    if (!trimmedNote) {
      setExpanded(false);
      return;
    }
    setSending(true);
    const result = await submitFeedback({
      threadId,
      turnId,
      rating,
      note: trimmedNote,
    });
    setSending(false);
    setDelivery(result.noteCaptured ? "sent" : "local");
    if (result.noteCaptured) {
      setExpanded(false);
      showSentConfirmation();
    }
  };

  return (
    <div
      className="relative flex min-w-0 flex-1 basis-80 items-start gap-1.5 self-start"
      data-response-feedback
    >
      <div className="flex shrink-0 items-center gap-1" aria-label="Rate this response">
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label="Helpful response"
          aria-pressed={rating === "positive"}
          data-analytics-id="response-feedback.positive"
          onClick={() => void chooseRating("positive")}
          className={cn(
            "border-border/20 bg-foreground/[0.02] text-muted-foreground/40 shadow-none hover:border-border/55 hover:bg-muted/40 hover:text-foreground/75",
            rating === "positive" &&
              "border-foreground/25 bg-muted text-foreground shadow-sm ring-1 ring-foreground/15",
          )}
        >
          <ThumbsUpIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label="Unhelpful response"
          aria-pressed={rating === "negative"}
          data-analytics-id="response-feedback.negative"
          onClick={() => void chooseRating("negative")}
          className={cn(
            "border-border/20 bg-foreground/[0.02] text-muted-foreground/40 shadow-none hover:border-border/55 hover:bg-muted/40 hover:text-foreground/75",
            rating === "negative" &&
              "border-foreground/25 bg-muted text-foreground shadow-sm ring-1 ring-foreground/15",
          )}
        >
          <ThumbsDownIcon className="size-3.5" />
        </Button>
      </div>

      {expanded && rating ? (
        <div className="flex min-w-0 max-w-2xl flex-1 items-start gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2 py-1.5">
          <label htmlFor={noteId} className="sr-only">
            Optional Feedback
          </label>
          <textarea
            ref={noteRef}
            id={noteId}
            rows={1}
            maxLength={MAX_RESPONSE_FEEDBACK_LENGTH}
            value={note}
            placeholder="Optional Feedback"
            onChange={(event) => {
              setNote(event.currentTarget.value);
              setDelivery("idle");
              resizeNoteField(event.currentTarget);
            }}
            className="min-h-6 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 text-xs leading-6 text-foreground/85 outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />
          {delivery === "local" ? (
            <span className="hidden shrink-0 text-[10px] text-muted-foreground/55 sm:inline">
              Saved locally
            </span>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={sending || !note.trim()}
            data-analytics-id="response-feedback.submit-note"
            onClick={() => void submitNote()}
            className="h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {sending ? (
              "Sending…"
            ) : delivery === "sent" && note.trim() ? (
              <>
                <CheckIcon className="size-3" />
                Sent
              </>
            ) : (
              <>
                <SendIcon className="size-3" />
                Send
              </>
            )}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close feedback note"
            onClick={() => setExpanded(false)}
            className="size-6 shrink-0 text-muted-foreground/45 hover:text-foreground/75"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      {!expanded && confirmationPhase !== "hidden" ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/45 bg-muted/45 px-2 text-[10px] font-medium text-foreground/75 transition-all duration-200 motion-reduce:transition-none",
            confirmationPhase === "visible"
              ? "translate-x-0 opacity-100"
              : "-translate-x-1 opacity-0",
          )}
        >
          <CheckIcon className="size-3" />
          Feedback sent
        </div>
      ) : null}
    </div>
  );
}
