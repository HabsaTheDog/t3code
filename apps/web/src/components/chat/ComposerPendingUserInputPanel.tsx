import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  CheckIcon,
  Clock3Icon,
  KeyRoundIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import {
  formatStudyBuddyQuizTime,
  parseStudyBuddyQuizPermissionQuestion,
  quizCapabilityLabel,
  quizPermissionOptionCopy,
  type StudyBuddyQuizPermissionDetails,
} from "./studyBuddyQuizPermission";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const quizPermission = parseStudyBuddyQuizPermissionQuestion(activeQuestion);
  if (quizPermission) {
    return (
      <StudyBuddyQuizPermissionCard
        details={quizPermission}
        question={activeQuestion}
        selectedOptionLabels={progress.selectedOptionLabels}
        isResponding={isResponding}
        onSelect={handleOptionSelection}
      />
    );
  }

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            {activeQuestion.header}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      <div className="mt-3 space-y-1">
        {activeQuestion.options.map((option, index) => {
          const isSelected = progress.selectedOptionLabels.includes(option.label);
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => handleOptionSelection(activeQuestion.id, option.label)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                isSelected
                  ? "border-blue-500/40 bg-blue-500/8 text-foreground"
                  : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                    isSelected
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground/50">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
});

function StudyBuddyQuizPermissionCard({
  details,
  question,
  selectedOptionLabels,
  isResponding,
  onSelect,
}: {
  details: StudyBuddyQuizPermissionDetails;
  question: NonNullable<ReturnType<typeof derivePendingUserInputProgress>["activeQuestion"]>;
  selectedOptionLabels: readonly string[];
  isResponding: boolean;
  onSelect: (questionId: string, optionLabel: string) => void;
}) {
  const quizTitle = details.quizTitle.replace(/\s*\|\s*FHTW Moodle\s*$/i, "");
  const expiry = formatExpiry(details.expiresAt);
  const attemptSummary = formatAttemptSummary(details);

  return (
    <section
      className="max-h-[75dvh] overflow-y-auto overscroll-contain px-4 py-4 sm:px-5 sm:py-5"
      aria-labelledby={`${question.id}-title`}
      data-study-buddy-quiz-permission="true"
    >
      <div className="flex items-start gap-3.5">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-400/10 text-amber-300">
          <ShieldCheckIcon className="size-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10px] font-semibold tracking-[0.16em] text-amber-300/80 uppercase">
              Quiz access
            </span>
            <span className="rounded border border-border/55 bg-background/35 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">
              This quiz only
            </span>
          </div>
          <h2
            id={`${question.id}-title`}
            className="mt-1 text-[15px] font-semibold text-foreground"
          >
            {quizTitle}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
            Approve once; technical continuation runs for the same attempt are included.
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-1 divide-y divide-border/45 overflow-hidden rounded-lg border border-border/55 bg-background/25 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <PermissionFact
          icon={Clock3Icon}
          label="Time limit"
          value={formatStudyBuddyQuizTime(details)}
        />
        <PermissionFact icon={KeyRoundIcon} label="Attempts" value={attemptSummary} />
        <PermissionFact
          icon={ShieldCheckIcon}
          label="Status"
          value={formatQuizAvailability(details)}
        />
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_0.86fr]">
        <div className="border-l-2 border-emerald-400/45 pl-3">
          <p className="text-[11px] font-semibold tracking-wide text-emerald-300/85 uppercase">
            Study Buddy can
          </p>
          <ul className="mt-2 grid gap-x-4 gap-y-1.5 text-xs text-foreground/80 sm:grid-cols-2">
            {details.capabilities.map((capability) => (
              <li key={capability} className="flex items-start gap-2 leading-snug">
                <CheckIcon
                  className="mt-0.5 size-3.5 shrink-0 text-emerald-400/80"
                  aria-hidden="true"
                />
                <span>{quizCapabilityLabel(capability)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-l-2 border-amber-400/45 pl-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-amber-300/85 uppercase">
            <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
            Stays with you
          </div>
          <p className="mt-2 text-sm font-medium text-foreground/90">Final quiz submission</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
            Study Buddy can save and continue, but can never submit the attempt.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/45 pt-3 text-[11px] text-muted-foreground/60">
        <span>Valid for the entire approved attempt</span>
        {expiry ? <span>Access valid until {expiry}</span> : null}
        {details.targetUrl ? <span>{safeHostname(details.targetUrl)}</span> : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {question.options.map((option, index) => {
          const copy = quizPermissionOptionCopy(option.label, option.description);
          const isSelected = selectedOptionLabels.includes(option.label);
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${question.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => onSelect(question.id, option.label)}
              className={cn(
                "group flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55",
                copy.intent === "approve"
                  ? "border-emerald-400/25 bg-emerald-400/8 hover:border-emerald-400/45 hover:bg-emerald-400/12"
                  : "border-border/55 bg-background/25 hover:border-border hover:bg-muted/35",
                isSelected &&
                  (copy.intent === "approve"
                    ? "border-emerald-400/55 bg-emerald-400/15"
                    : "border-blue-400/45 bg-blue-400/10"),
                isResponding && "cursor-not-allowed opacity-50",
              )}
            >
              {shortcutKey !== null ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center rounded bg-muted/45 text-[11px] font-medium text-muted-foreground/65">
                  {shortcutKey}
                </kbd>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{copy.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/65">
                  {copy.description}
                </span>
              </span>
              {isSelected ? (
                <CheckIcon
                  className={cn(
                    "size-4 shrink-0",
                    copy.intent === "approve" ? "text-emerald-400" : "text-blue-400",
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PermissionFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3Icon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground/55" aria-hidden="true" />
      <div className="min-w-0">
        <dt className="text-[10px] font-medium tracking-wide text-muted-foreground/55 uppercase">
          {label}
        </dt>
        <dd className="mt-0.5 break-words text-xs leading-snug font-medium text-foreground/85">
          {value}
        </dd>
      </div>
    </div>
  );
}

function formatAttemptSummary(details: StudyBuddyQuizPermissionDetails): string {
  if (details.attemptsUnlimited) return "Unlimited";
  if (details.attemptsLeft !== null) {
    if (details.attemptsAllowed !== null && details.attemptsUsed !== null) {
      return `${details.attemptsLeft} left · ${details.attemptsUsed}/${details.attemptsAllowed} used`;
    }
    return `${details.attemptsLeft} left`;
  }
  if (details.attemptsAllowed !== null && details.attemptsUsed !== null) {
    return `${Math.max(0, details.attemptsAllowed - details.attemptsUsed)} left`;
  }
  return "Not provided";
}

function formatQuizAvailability(details: StudyBuddyQuizPermissionDetails): string {
  if (details.hasActiveAttempt) return "Attempt in progress";
  switch (details.availabilityStatus) {
    case "open":
      return details.canStartNewAttempt === false ? "Open · no new attempt" : "Open";
    case "closed":
      return "Closed";
    case "not_yet_open":
      return "Not open yet";
    case "attempts_exhausted":
      return "No attempts left";
    case "unavailable":
      return "Unavailable";
    case "unknown":
      return "Availability unknown";
    default:
      return details.hasActiveAttempt === false ? "Not started" : "Not provided";
  }
}

function formatExpiry(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "Moodle";
  }
}
