import type {
  StudyBuddyConfiguration,
  StudyBuddyConfigurationPatch,
  StudyBuddyConnectionTarget,
  StudyBuddyConnectionTestResult,
  TelemetryConsentDecision,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CircleIcon,
  BotIcon,
  AudioWaveformIcon,
  GraduationCapIcon,
  LinkIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  WandSparklesIcon,
  WifiIcon,
  XCircleIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { isHostedStaticApp } from "../hostedPairing";
import { getPrimaryKnownEnvironment } from "../environments/primary";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { SecretInput } from "../components/ui/secret-input";
import { Spinner } from "../components/ui/spinner";
import { Input } from "../components/ui/input";
import {
  QUIZ_ACCESS_MODE_OPTIONS,
  isQuizAccessMode,
  type QuizAccessMode,
} from "../components/settings/StudyBuddySettings.logic";
import { subscribeSetupRerun } from "./setupCoordinator";
import { systemTelemetryRandom } from "../telemetry/types";
import { registerTelemetrySecret, telemetry } from "../telemetry/runtime";
import { ProviderSetupStep, type ProviderSetupStepHandle } from "./ProviderSetupStep";
import { SpeechModelCard } from "../components/speech/SpeechModelCard";

export const ONBOARDING_VERSION = 1;
export const CONSENT_VERSION = 1;
const SETUP_BRAND_LOGO_SRC = "/logo-highlight.png";

type SetupStepId =
  | "privacy"
  | "environment"
  | "provider"
  | "voice"
  | "moodle"
  | "cis"
  | "calendar"
  | "quiz-safety";

interface SetupStep {
  id: SetupStepId;
  label: string;
  icon: typeof ShieldCheckIcon;
}

type StepSaveHandle = {
  save: () => Promise<boolean>;
};

const ALL_STEPS: readonly SetupStep[] = [
  { id: "privacy", label: "Privacy", icon: ShieldCheckIcon },
  { id: "environment", label: "Environment", icon: WifiIcon },
  { id: "provider", label: "Codex", icon: BotIcon },
  { id: "voice", label: "Voice input", icon: AudioWaveformIcon },
  { id: "moodle", label: "Moodle", icon: GraduationCapIcon },
  { id: "cis", label: "CIS", icon: LockKeyholeIcon },
  { id: "calendar", label: "Calendar", icon: LinkIcon },
  { id: "quiz-safety", label: "Quiz safety", icon: ShieldCheckIcon },
];

function normalizeSetupStepId(stepId: string | null): SetupStepId | null {
  switch (stepId) {
    case "accounts":
      return "moodle";
    case "sources":
      return "cis";
    case "sys":
      return "cis";
    case "summary":
      return "quiz-safety";
    case "privacy":
    case "environment":
    case "provider":
    case "voice":
    case "moodle":
    case "cis":
    case "calendar":
    case "quiz-safety":
      return stepId;
    default:
      return null;
  }
}

export function SetupGate({ children }: { children: React.ReactNode }) {
  const hydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const { updateClientSettingsDurably } = useUpdateSettings();
  const [deferredForSession, setDeferredForSession] = useState(false);
  const [forced, setForced] = useState(
    () => new URL(window.location.href).searchParams.get("setup") === "1",
  );

  useEffect(() => subscribeSetupRerun(() => setForced(true)), []);

  const needsSetup =
    forced ||
    settings.consentVersion < CONSENT_VERSION ||
    settings.onboardingStatus !== "completed" ||
    settings.onboardingVersion < ONBOARDING_VERSION;

  if (!hydrated || deferredForSession || !needsSetup) {
    return children;
  }

  return (
    <SetupWizard
      forced={forced}
      onOpenEnvironment={async () => {
        await updateClientSettingsDurably({
          onboardingStatus: "in-progress",
          onboardingCurrentStep: "environment",
        });
        setDeferredForSession(true);
        setForced(false);
      }}
      onCompleted={async () => {
        await updateClientSettingsDurably({
          onboardingVersion: ONBOARDING_VERSION,
          onboardingStatus: "completed",
          onboardingCurrentStep: null,
        });
        setForced(false);
      }}
    />
  );
}

function SetupWizard({
  forced,
  onOpenEnvironment,
  onCompleted,
}: {
  forced: boolean;
  onOpenEnvironment: () => Promise<void>;
  onCompleted: () => Promise<void>;
}) {
  const settings = useSettings();
  const { updateClientSettingsDurably } = useUpdateSettings();
  const includeEnvironment =
    isHostedStaticApp(new URL(window.location.href)) && !getPrimaryKnownEnvironment();
  const steps = useMemo(
    () => ALL_STEPS.filter((step) => includeEnvironment || step.id !== "environment"),
    [includeEnvironment],
  );
  const persistedIndex =
    settings.consentVersion < CONSENT_VERSION
      ? 0
      : steps.findIndex((step) => step.id === normalizeSetupStepId(settings.onboardingCurrentStep));
  const [stepIndex, setStepIndex] = useState(Math.max(0, persistedIndex));
  const [analyticsDecision, setAnalyticsDecision] = useState<TelemetryConsentDecision>(
    settings.consentVersion === CONSENT_VERSION ? settings.analyticsConsent : "unset",
  );
  const [conversationDecision, setConversationDecision] = useState<TelemetryConsentDecision>(
    settings.consentVersion === CONSENT_VERSION ? settings.conversationConsent : "unset",
  );
  const [privacySaveError, setPrivacySaveError] = useState<string | null>(null);
  const [stepSaveError, setStepSaveError] = useState<string | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [savingStep, setSavingStep] = useState(false);
  const [sessionConnectionChecks, setSessionConnectionChecks] = useState<
    Partial<Record<StudyBuddyConnectionTarget, StudyBuddyConnectionTestResult>>
  >({});
  const studyConfigurationStepRef = useRef<StepSaveHandle>(null);
  const quizSafetyStepRef = useRef<StepSaveHandle>(null);
  const providerSetupStepRef = useRef<ProviderSetupStepHandle>(null);
  const privacySelectionMade = analyticsDecision !== "unset" || conversationDecision !== "unset";

  const step = steps[stepIndex] ?? steps[0]!;
  useEffect(() => {
    void telemetry.capture({
      event: "setup.step_viewed",
      properties: { step: step.id },
    });
  }, [step.id]);

  const goTo = async (nextIndex: number): Promise<boolean> => {
    const bounded = Math.min(Math.max(nextIndex, 0), steps.length - 1);
    setStepSaveError(null);
    setSavingStep(true);
    try {
      await updateClientSettingsDurably({
        onboardingStatus: "in-progress",
        onboardingCurrentStep: steps[bounded]?.id ?? "privacy",
      });
      setStepIndex(bounded);
      return true;
    } catch {
      setStepSaveError("We couldn’t save your progress. Please try again.");
      return false;
    } finally {
      setSavingStep(false);
    }
  };

  const commitPrivacyDecision = async (
    analyticsConsent: TelemetryConsentDecision,
    conversationConsent: TelemetryConsentDecision,
    telemetryEvent: "setup.step_completed" | "setup.step_skipped",
  ) => {
    const normalizedAnalyticsConsent = analyticsConsent === "unset" ? "rejected" : analyticsConsent;
    const normalizedConversationConsent =
      conversationConsent === "unset" ? "rejected" : conversationConsent;
    const now = new Date().toISOString();
    setPrivacySaveError(null);
    setSavingPrivacy(true);
    try {
      const anyAccepted =
        normalizedAnalyticsConsent === "accepted" || normalizedConversationConsent === "accepted";
      const next = await updateClientSettingsDurably({
        installationId: anyAccepted
          ? settings.installationId || systemTelemetryRandom.uuid()
          : settings.installationId,
        analyticsConsent: normalizedAnalyticsConsent,
        conversationConsent: normalizedConversationConsent,
        consentVersion: CONSENT_VERSION,
        consentUpdatedAt: now,
        analyticsEnabledAt:
          normalizedAnalyticsConsent === "accepted"
            ? settings.analyticsConsent === "accepted"
              ? (settings.analyticsEnabledAt ?? now)
              : now
            : null,
        conversationEnabledAt:
          normalizedConversationConsent === "accepted"
            ? settings.conversationConsent === "accepted"
              ? (settings.conversationEnabledAt ?? now)
              : now
            : null,
      });
      await telemetry.updateConsent({
        hydrated: true,
        installationId: next.installationId || null,
        analyticsConsent: next.analyticsConsent,
        conversationConsent: next.conversationConsent,
        analyticsEnabledAt: next.analyticsEnabledAt,
        conversationEnabledAt: next.conversationEnabledAt,
      });
      if (await goTo(stepIndex + 1)) {
        void telemetry.capture({
          event: telemetryEvent,
          properties: { step: "privacy" },
        });
      }
    } catch {
      setPrivacySaveError("We couldn’t save your choices. Nothing changed, so please try again.");
      void telemetry.capture({
        event: "setup.step_failed",
        properties: { step: "privacy", reason: "local_persistence" },
      });
    } finally {
      setSavingPrivacy(false);
    }
  };

  const skipPrivacyStep = async () => {
    await commitPrivacyDecision("rejected", "rejected", "setup.step_skipped");
  };

  const continueStep = async () => {
    setSavingStep(true);
    try {
      const currentStepSaved =
        step.id === "provider"
          ? await providerSetupStepRef.current?.save()
          : step.id === "moodle" || step.id === "cis" || step.id === "calendar"
            ? await studyConfigurationStepRef.current?.save()
            : step.id === "quiz-safety"
              ? await quizSafetyStepRef.current?.save()
              : true;
      if (currentStepSaved === false) return;

      if (stepIndex === steps.length - 1) {
        setStepSaveError(null);
        setSavingStep(true);
        try {
          await onCompleted();
          void telemetry.capture({
            event: "setup.step_completed",
            properties: { step: step.id },
          });
        } catch {
          setStepSaveError("We couldn’t finish setup. Please try again.");
        } finally {
          setSavingStep(false);
        }
        return;
      }
      if (await goTo(stepIndex + 1)) {
        void telemetry.capture({
          event: "setup.step_completed",
          properties: { step: step.id },
        });
      }
    } finally {
      setSavingStep(false);
    }
  };

  const skipStep = async () => {
    if (await goTo(stepIndex + 1)) {
      void telemetry.capture({
        event: "setup.step_skipped",
        properties: { step: step.id },
      });
    }
  };

  return (
    <main className="fixed inset-0 z-[100] overflow-hidden bg-background text-foreground">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_14%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_30%),linear-gradient(125deg,var(--background),color-mix(in_srgb,var(--background)_92%,var(--muted)))]" />
      <div className="relative grid h-full lg:grid-cols-[300px_1fr]">
        <aside className="hidden border-r border-border/70 bg-card/50 p-8 backdrop-blur-xl lg:flex lg:flex-col">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl border bg-background shadow-sm">
              <img
                alt=""
                aria-hidden="true"
                className="size-6 object-contain"
                draggable={false}
                src={SETUP_BRAND_LOGO_SRC}
              />
            </div>
            <div>
              <p className="text-sm font-semibold">{APP_DISPLAY_NAME}</p>
              <p className="text-xs text-muted-foreground">
                {forced ? "Setup" : "Let’s get started"}
              </p>
            </div>
          </div>
          <ol className="mt-12 space-y-1" aria-label="Setup progress">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const active = index === stepIndex;
              const complete = index < stepIndex;
              return (
                <li
                  key={item.id}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-3 text-sm",
                    active && "bg-accent text-foreground",
                    !active && "text-muted-foreground",
                  )}
                >
                  {complete ? (
                    <CheckCircle2Icon className="size-4 text-emerald-500" />
                  ) : active ? (
                    <Icon className="size-4 text-primary" />
                  ) : (
                    <CircleIcon className="size-4 opacity-40" />
                  )}
                  {item.label}
                </li>
              );
            })}
          </ol>
          <p className="mt-auto text-xs leading-5 text-muted-foreground">
            You only need Codex to get started. Moodle, CIS, Calendar, and voice input can all be
            added later.
          </p>
        </aside>

        <section className="flex min-h-0 flex-col">
          <header
            data-setup-header="true"
            className="drag-region grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border/60 px-5 lg:px-10 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
          >
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
              {step.label}
            </h1>
            <p className="rounded-full border border-border/70 bg-card/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground shadow-sm backdrop-blur">
              Step {stepIndex + 1} of {steps.length}
            </p>
            <div aria-hidden="true" />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 lg:px-10 lg:py-12">
            <div className="mx-auto max-w-4xl">
              {step.id === "privacy" ? (
                <>
                  <PrivacyStep
                    analytics={analyticsDecision}
                    conversation={conversationDecision}
                    onAnalytics={setAnalyticsDecision}
                    onConversation={setConversationDecision}
                    onAllowAll={() =>
                      void commitPrivacyDecision("accepted", "accepted", "setup.step_completed")
                    }
                    onRejectAll={() =>
                      void commitPrivacyDecision("rejected", "rejected", "setup.step_completed")
                    }
                  />
                  {privacySaveError ? (
                    <p className="mt-4 text-sm text-destructive" role="alert">
                      {privacySaveError}
                    </p>
                  ) : null}
                </>
              ) : null}
              {stepSaveError ? (
                <p className="mt-4 text-sm text-destructive" role="alert">
                  {stepSaveError}
                </p>
              ) : null}
              {step.id === "environment" ? (
                <EnvironmentStep onOpenEnvironment={onOpenEnvironment} />
              ) : null}
              {step.id === "provider" ? (
                <ProviderStep providerSetupStepRef={providerSetupStepRef} />
              ) : null}
              {step.id === "voice" ? <VoiceInputStep /> : null}
              {step.id === "moodle" ? (
                <StudyConfigurationStep
                  key="moodle"
                  ref={studyConfigurationStepRef}
                  target="moodle"
                  connectionCheck={sessionConnectionChecks.moodle ?? null}
                  onConnectionCheck={(result) =>
                    setSessionConnectionChecks((current) => ({ ...current, moodle: result }))
                  }
                />
              ) : null}
              {step.id === "cis" ? (
                <StudyConfigurationStep
                  key="cis"
                  ref={studyConfigurationStepRef}
                  target="cis"
                  connectionCheck={sessionConnectionChecks.cis ?? null}
                  onConnectionCheck={(result) =>
                    setSessionConnectionChecks((current) => ({ ...current, cis: result }))
                  }
                />
              ) : null}
              {step.id === "calendar" ? (
                <StudyConfigurationStep
                  key="calendar"
                  ref={studyConfigurationStepRef}
                  target="calendar"
                  connectionCheck={sessionConnectionChecks.calendar ?? null}
                  onConnectionCheck={(result) =>
                    setSessionConnectionChecks((current) => ({ ...current, calendar: result }))
                  }
                />
              ) : null}
              {step.id === "quiz-safety" ? <QuizSafetyStep ref={quizSafetyStepRef} /> : null}
            </div>
          </div>

          <footer
            className={cn(
              "flex items-center border-t border-border/60 bg-background/80 px-5 py-4 backdrop-blur lg:px-10",
              step.id === "privacy" ? "justify-end" : "justify-between",
            )}
          >
            {step.id === "privacy" ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  data-analytics-id="setup.skip"
                  disabled={savingPrivacy}
                  onClick={() => void skipPrivacyStep()}
                >
                  Skip
                </Button>
                {privacySelectionMade ? (
                  <Button
                    data-analytics-id="setup.privacy.continue"
                    disabled={savingPrivacy}
                    onClick={() =>
                      void commitPrivacyDecision(
                        analyticsDecision,
                        conversationDecision,
                        "setup.step_completed",
                      )
                    }
                  >
                    {savingPrivacy ? "Saving…" : "Continue"}
                    <ChevronRightIcon className="size-4" />
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <Button
                            data-analytics-id="setup.privacy.continue"
                            disabled
                            onClick={() => undefined}
                          >
                            Continue
                            <ChevronRightIcon className="size-4" />
                          </Button>
                        </span>
                      }
                    />
                    <TooltipPopup side="top">
                      Choose what you’d like to share, or select No thanks.
                    </TooltipPopup>
                  </Tooltip>
                )}
              </div>
            ) : (
              <>
                <Button
                  variant="outline"
                  data-analytics-id="setup.back"
                  disabled={stepIndex === 0 || savingStep}
                  onClick={() => void goTo(stepIndex - 1)}
                >
                  <ChevronLeftIcon className="size-4" />
                  Back
                </Button>
                <div className="flex items-center gap-2">
                  {stepIndex < steps.length - 1 && step.id !== "provider" ? (
                    <Button
                      variant="ghost"
                      data-analytics-id="setup.skip"
                      disabled={savingStep}
                      onClick={() => void skipStep()}
                    >
                      Skip
                    </Button>
                  ) : null}
                  <Button
                    data-analytics-id={
                      stepIndex === steps.length - 1 ? "setup.finish" : "setup.continue"
                    }
                    disabled={savingStep}
                    onClick={() => void continueStep()}
                  >
                    {savingStep
                      ? "Saving…"
                      : stepIndex === steps.length - 1
                        ? "Finish setup"
                        : "Continue"}
                    <ChevronRightIcon className="size-4" />
                  </Button>
                </div>
              </>
            )}
          </footer>
        </section>
      </div>
    </main>
  );
}

function PrivacyStep({
  analytics,
  conversation,
  onAnalytics,
  onConversation,
  onAllowAll,
  onRejectAll,
}: {
  analytics: TelemetryConsentDecision;
  conversation: TelemetryConsentDecision;
  onAnalytics: (decision: TelemetryConsentDecision) => void;
  onConversation: (decision: TelemetryConsentDecision) => void;
  onAllowAll: () => void;
  onRejectAll: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <Badge variant="secondary" className="w-fit">
            Optional — change this anytime
          </Badge>
          <p className="text-[1.75rem] font-semibold tracking-[-0.04em] sm:text-[2rem]">
            Help us improve Study Buddy
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            You can share a little about how you use Study Buddy to help us make it better. Sharing
            is off until you choose it, and you can change your mind at any time.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          data-analytics-id="setup.privacy.select-all"
          disabled={analytics === "accepted" && conversation === "accepted"}
          onClick={() => {
            onAnalytics("accepted");
            onConversation("accepted");
            onAllowAll();
          }}
        >
          Share both
        </Button>
        <Button
          variant="outline"
          data-analytics-id="setup.privacy.reject-all"
          disabled={analytics === "rejected" && conversation === "rejected"}
          onClick={() => {
            onAnalytics("rejected");
            onConversation("rejected");
            onRejectAll();
          }}
        >
          No thanks
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <ConsentCard
          title="Usage analytics"
          description="Share which parts of Study Buddy you use and roughly where people click on each screen. We never include exact page addresses, what you type, mouse movement, scrolling, passwords, or file contents."
          decision={analytics}
          onDecision={onAnalytics}
        />
        <ConsentCard
          title="Conversation sharing"
          description="Share your messages, Study Buddy’s replies, and any feedback you leave, plus basic details about files it creates or changes. Passwords and file contents are not included."
          decision={conversation}
          onDecision={onConversation}
        />
      </div>

      <Button
        variant="link"
        size="sm"
        className="h-auto px-0 text-left text-sm font-medium text-primary underline underline-offset-4"
        render={<Link to="/privacy" />}
      >
        Read full privacy notice
      </Button>
    </div>
  );
}

function ConsentCard({
  title,
  description,
  decision,
  onDecision,
}: {
  title: string;
  description: string;
  decision: TelemetryConsentDecision;
  onDecision: (decision: TelemetryConsentDecision) => void;
}) {
  const titleId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  const descriptionId = `${titleId}-description`;
  return (
    <Card
      className="overflow-hidden border-border/80 shadow-sm transition-transform duration-150 hover:-translate-y-0.5 hover:border-border"
      render={
        <button
          type="button"
          role="checkbox"
          aria-checked={decision === "accepted"}
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          className={cn(
            "group flex cursor-pointer flex-col gap-4 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            decision === "accepted"
              ? "bg-primary/6"
              : "bg-card hover:bg-accent/35 data-[pressed]:bg-accent/35",
          )}
          onClick={() => onDecision(decision === "accepted" ? "unset" : "accepted")}
        />
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox checked={decision === "accepted"} aria-hidden="true" tabIndex={-1} />
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
          </div>
          <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <Badge variant={decision === "accepted" ? "success" : "secondary"}>
          {decision === "accepted" ? "Sharing" : "Not sharing"}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">Select this card to change it.</p>
    </Card>
  );
}

function EnvironmentStep({ onOpenEnvironment }: { onOpenEnvironment: () => Promise<void> }) {
  const [saveError, setSaveError] = useState(false);
  return (
    <div className="space-y-6">
      <StepIntro
        title="Connect Study Buddy"
        description="Connect this website to the Study Buddy app on your computer. You can also do this later from Settings."
        icon={LinkIcon}
      />
      <Button
        render={<a href="/settings/connections" />}
        data-analytics-id="setup.environment.open"
        onClick={(event) => {
          event.preventDefault();
          setSaveError(false);
          void onOpenEnvironment()
            .then(() => window.location.assign("/settings/connections"))
            .catch(() => setSaveError(true));
        }}
      >
        <LinkIcon className="size-4" />
        Connect app
      </Button>
      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          We couldn’t save your progress. Please try again.
        </p>
      ) : null}
    </div>
  );
}

function ProviderStep({
  providerSetupStepRef,
}: {
  providerSetupStepRef: React.RefObject<ProviderSetupStepHandle | null>;
}) {
  return (
    <div className="space-y-6">
      <StepIntro
        title="Connect Codex"
        description="Codex powers Study Buddy’s answers. Install it and sign in below. You only need to do this once."
        icon={BotIcon}
      />
      <ProviderSetupStep ref={providerSetupStepRef} />
    </div>
  );
}

function VoiceInputStep() {
  return (
    <div className="space-y-6">
      <StepIntro
        title="Use your voice"
        description="Want to speak instead of type? Download the optional voice feature now, or add it later in Settings → Study Buddy."
        icon={AudioWaveformIcon}
      />
      <SpeechModelCard />
    </div>
  );
}

interface StudyConfigurationStepProps {
  target: StudyBuddyConnectionTarget;
  connectionCheck: StudyBuddyConnectionTestResult | null;
  onConnectionCheck: (result: StudyBuddyConnectionTestResult) => void;
}

const StudyConfigurationStep = forwardRef<StepSaveHandle, StudyConfigurationStepProps>(
  function StudyConfigurationStep({ target, connectionCheck, onConnectionCheck }, ref) {
    const settings = useSettings();
    const { updateSettings } = useUpdateSettings();
    const [config, setConfig] = useState<StudyBuddyConfiguration | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const [checkingConnection, setCheckingConnection] = useState(false);
    const [moodleUsername, setMoodleUsername] = useState("");
    const [cisUsername, setCisUsername] = useState("");
    const [moodleUrl, setMoodleUrl] = useState("");
    const [cisUrl, setCisUrl] = useState("");
    const [moodlePassword, setMoodlePassword] = useState("");
    const [cisPassword, setCisPassword] = useState("");
    const [calendarUrl, setCalendarUrl] = useState("");
    const [secretInputResetVersion, setSecretInputResetVersion] = useState(0);
    const persistedConnectionChecks = settings.studyBuddyConnectionChecks ?? {};

    useEffect(() => {
      void ensureLocalApi()
        .server.getStudyBuddyConfiguration()
        .then((next) => {
          setConfig(next);
          setMoodleUsername(next.moodleUsername);
          setCisUsername(next.cisUsername);
          setMoodleUrl(next.moodleDashboardUrl);
          setCisUrl(next.cisUrl);
        })
        .catch(() => setUnavailable(true));
    }, []);

    useEffect(() => {
      if (!config) return;
      if (target === "moodle") {
        setMoodleUsername(config.moodleUsername);
        setMoodleUrl(config.moodleDashboardUrl);
      } else if (target === "cis") {
        setCisUsername(config.cisUsername);
        setCisUrl(config.cisUrl);
      } else {
        setCalendarUrl("");
      }
    }, [config, target]);

    const isConfigured =
      target === "moodle"
        ? Boolean(moodleUsername.trim()) &&
          Boolean(moodleUrl.trim()) &&
          (Boolean(moodlePassword.trim()) || config?.moodlePasswordConfigured)
        : target === "cis"
          ? Boolean(cisUsername.trim()) &&
            Boolean(cisUrl.trim()) &&
            (Boolean(cisPassword.trim()) || config?.cisPasswordConfigured)
          : Boolean(calendarUrl.trim()) || config?.calendarUrlConfigured;

    const hasDraftChanges =
      target === "moodle"
        ? moodleUsername !== (config?.moodleUsername ?? "") ||
          moodleUrl !== (config?.moodleDashboardUrl ?? "") ||
          Boolean(moodlePassword)
        : target === "cis"
          ? cisUsername !== (config?.cisUsername ?? "") ||
            cisUrl !== (config?.cisUrl ?? "") ||
            Boolean(cisPassword)
          : Boolean(calendarUrl);

    // A setup rerun is a new validation session. Persisted results remain useful
    // as history, but showing an old success here makes untested credentials look
    // green. Keep only checks performed during this mounted wizard, while still
    // retaining them when the user moves back and forth between its steps.
    const visibleConnectionCheck = hasDraftChanges ? null : connectionCheck;

    const recordConnectionCheck = (result: StudyBuddyConnectionTestResult) => {
      onConnectionCheck(result);
      updateSettings({
        studyBuddyConnectionChecks: {
          ...persistedConnectionChecks,
          [target]: result,
        },
      });
    };

    const connectionStatusKind: "idle" | "checking" | "success" | "error" = checkingConnection
      ? "checking"
      : visibleConnectionCheck?.status === "success"
        ? "success"
        : visibleConnectionCheck?.status === "failure"
          ? "error"
          : "idle";

    const connectionStatus = checkingConnection
      ? "Checking connection…"
      : (visibleConnectionCheck?.message ?? null);

    const buildPatch = (): StudyBuddyConfigurationPatch =>
      target === "moodle"
        ? {
            moodleUsername,
            moodleDashboardUrl: moodleUrl,
            moodlePassword: moodlePassword
              ? { operation: "set", value: moodlePassword }
              : { operation: "unchanged" },
          }
        : target === "cis"
          ? {
              cisUsername,
              cisUrl,
              cisPassword: cisPassword
                ? { operation: "set", value: cisPassword }
                : { operation: "unchanged" },
            }
          : {
              calendarUrlSecret: calendarUrl
                ? { operation: "set", value: calendarUrl }
                : { operation: "unchanged" },
            };

    const save = async () => {
      if (!config) return true;
      setSaveError(false);
      try {
        const secrets =
          target === "moodle" ? [moodlePassword] : target === "cis" ? [cisPassword] : [calendarUrl];
        for (const secret of secrets) {
          if (secret) registerTelemetrySecret(secret);
        }
        const next = await ensureLocalApi().server.updateStudyBuddyConfiguration({
          patch: buildPatch(),
        });
        setConfig(next);
        // Secrets are write-only. Once the backend has persisted one, clear the
        // draft so it cannot keep the connection result in the "changed" state
        // (and so the secret is not retained in the setup form).
        if (target === "moodle") setMoodlePassword("");
        else if (target === "cis") setCisPassword("");
        else setCalendarUrl("");
        setSecretInputResetVersion((current) => current + 1);
        void telemetry.capture({
          event: "settings.changed",
          properties: {
            section:
              target === "moodle"
                ? "study_moodle"
                : target === "cis"
                  ? "study_cis"
                  : "study_calendar",
          },
        });
        return true;
      } catch {
        setSaveError(true);
        void telemetry.capture({
          event: "setup.step_failed",
          properties: {
            step: target === "moodle" ? "moodle" : target === "cis" ? "cis" : "calendar",
            reason: "configuration_save",
          },
        });
        return false;
      }
    };

    const checkConnection = async () => {
      if (!config || unavailable || !isConfigured) {
        recordConnectionCheck({
          target,
          status: "failure",
          code: "not-configured",
          message: "Fill in the details above, then try again.",
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      setSaveError(false);
      setCheckingConnection(true);
      try {
        const saved = await save();
        if (!saved) {
          recordConnectionCheck({
            target,
            status: "failure",
            code: "unreachable",
            message: "We couldn’t check the connection. Please try again.",
            checkedAt: new Date().toISOString(),
          });
          return;
        }
        const result = await ensureLocalApi().server.testStudyBuddyConnection({ target });
        recordConnectionCheck(result);
        void telemetry.capture({
          event: "study_connection.tested",
          properties: { target, outcome: result.status },
        });
      } catch (testError) {
        const message =
          testError instanceof Error
            ? testError.message
            : "We couldn’t check the connection. Please try again.";
        const result: StudyBuddyConnectionTestResult = {
          target,
          status: "failure",
          code: "unreachable",
          message,
          checkedAt: new Date().toISOString(),
        };
        recordConnectionCheck(result);
        void telemetry.capture({
          event: "study_connection.tested",
          properties: { target, outcome: "error" },
        });
      } finally {
        setCheckingConnection(false);
      }
    };

    useImperativeHandle(ref, () => ({ save }), [save]);

    return (
      <div className="space-y-6">
        <StepIntro
          title={
            target === "moodle"
              ? "Connect Moodle"
              : target === "cis"
                ? "Connect CIS"
                : "Connect your calendar"
          }
          description={
            unavailable
              ? "Connect Study Buddy to this device first. You can finish this later in Settings → Study Buddy."
              : target === "calendar"
                ? "Paste your private calendar link so Study Buddy can check upcoming classes, exams, and deadlines."
                : target === "moodle"
                  ? "Use your usual Moodle sign-in so Study Buddy can find your courses and learning material."
                  : "Use your usual CIS sign-in so Study Buddy can check schedules, rooms, exams, and study information."
          }
          icon={
            target === "moodle" ? GraduationCapIcon : target === "cis" ? LockKeyholeIcon : LinkIcon
          }
        />
        <ConnectionPrivacyNote target={target} />
        <Card className="divide-y divide-border/60">
          {(target === "moodle"
            ? [
                {
                  label: "Moodle website",
                  value: moodleUrl,
                  setValue: setMoodleUrl,
                  secret: false,
                  placeholder: "https://moodle.technikum-wien.at",
                },
                {
                  label: "Moodle username",
                  value: moodleUsername,
                  setValue: setMoodleUsername,
                  secret: false,
                  placeholder: "Your student username",
                },
                {
                  label: "Moodle password",
                  value: moodlePassword,
                  setValue: setMoodlePassword,
                  secret: true,
                  placeholder: "Your Moodle password",
                },
              ]
            : target === "cis"
              ? [
                  {
                    label: "CIS website",
                    value: cisUrl,
                    setValue: setCisUrl,
                    secret: false,
                    placeholder: "https://cis.technikum-wien.at",
                  },
                  {
                    label: "CIS username",
                    value: cisUsername,
                    setValue: setCisUsername,
                    secret: false,
                    placeholder: "Leave empty if it matches Moodle",
                  },
                  {
                    label: "CIS password",
                    value: cisPassword,
                    setValue: setCisPassword,
                    secret: true,
                    placeholder: "Your CIS password",
                  },
                ]
              : [
                  {
                    label: "Private calendar link",
                    value: calendarUrl,
                    setValue: setCalendarUrl,
                    secret: true,
                    placeholder: "https://…/calendar.ics",
                  },
                ]
          ).map((field) => (
            <label key={field.label} className="block px-5 py-4">
              <span className="text-sm font-medium">{field.label}</span>
              {field.secret ? (
                <SecretInput
                  resetKey={`${target}-${field.label}-${secretInputResetVersion}`}
                  label={field.label}
                  className="pt-2"
                  inputClassName="mt-0"
                  disabled={unavailable || !config}
                  autoComplete="new-password"
                  placeholder={field.placeholder}
                  onValueChange={field.setValue}
                />
              ) : (
                <Input
                  nativeInput
                  className="mt-2"
                  value={field.value}
                  placeholder={field.placeholder}
                  disabled={unavailable || !config}
                  autoComplete="off"
                  onChange={(event) => field.setValue(event.currentTarget.value)}
                />
              )}
            </label>
          ))}
        </Card>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={unavailable || !config || checkingConnection}
            onClick={() => void checkConnection()}
          >
            {checkingConnection ? <Spinner className="size-4" /> : null}
            {checkingConnection ? "Checking…" : "Check connection"}
          </Button>
          <div className="flex items-center gap-2">
            {connectionStatusKind === "success" ? (
              <CheckCircle2Icon
                className="size-4 shrink-0 text-emerald-400"
                aria-label="Connection check passed"
              />
            ) : connectionStatusKind === "error" ? (
              <XCircleIcon
                className="size-4 shrink-0 text-destructive"
                aria-label="Connection check failed"
              />
            ) : null}
            <p
              className={cn(
                "text-xs leading-5",
                connectionStatusKind === "success"
                  ? "text-emerald-400"
                  : connectionStatusKind === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              {connectionStatus ?? "Check the connection to make sure everything works."}
            </p>
          </div>
        </div>
        {!unavailable ? (
          <>
            {saveError ? (
              <p className="text-xs text-destructive" role="alert">
                We couldn’t save these details. Please try again.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);

const QuizSafetyStep = forwardRef<StepSaveHandle>(function QuizSafetyStep(_, ref) {
  const [config, setConfig] = useState<StudyBuddyConfiguration | null>(null);
  const [mode, setMode] = useState<QuizAccessMode>("review-only");
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    void ensureLocalApi()
      .server.getStudyBuddyConfiguration()
      .then((next) => {
        setConfig(next);
        setMode(next.quiz.accessMode);
      })
      .catch(() => undefined);
  }, []);

  const saveMode = async () => {
    if (!config) return true;
    setSaveError(false);
    try {
      const next = await ensureLocalApi().server.updateStudyBuddyConfiguration({
        patch: { quiz: { ...config.quiz, accessMode: mode } },
      });
      setConfig(next);
      return true;
    } catch {
      setSaveError(true);
      void telemetry.capture({
        event: "setup.step_failed",
        properties: { step: "quiz-safety", reason: "configuration_save" },
      });
      return false;
    }
  };

  useImperativeHandle(ref, () => ({ save: saveMode }), [saveMode]);

  const modeIcons: Record<QuizAccessMode, typeof ShieldCheckIcon> = {
    "review-only": BookOpenIcon,
    "ask-before-attempt": CircleHelpIcon,
    "quiz-assist": WandSparklesIcon,
  };

  return (
    <div className="space-y-6">
      <StepIntro
        title="Choose how Study Buddy helps with quizzes"
        description="You stay in control. Study Buddy will never click the final submit button for you."
        icon={ShieldCheckIcon}
      />
      <div className="space-y-4">
        <div className="flex items-start gap-3 px-1">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border bg-card shadow-sm">
            <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Quiz help</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Choose the level of help you’re comfortable with. You can change this later in
              Settings.
            </p>
          </div>
        </div>
        <RadioGroup
          className="grid gap-3"
          value={mode}
          onValueChange={(value) => {
            if (isQuizAccessMode(value)) setMode(value);
          }}
        >
          {QUIZ_ACCESS_MODE_OPTIONS.map((option) => {
            const selected = mode === option.value;
            const ModeIcon = modeIcons[option.value];
            return (
              <label
                key={option.value}
                data-quiz-access-option={option.value}
                className={cn(
                  "group flex cursor-pointer items-start gap-4 rounded-2xl border bg-card px-5 py-4 text-left shadow-sm transition-colors",
                  selected
                    ? "border-primary/45 bg-primary/8"
                    : "border-border/75 hover:border-border hover:bg-accent/35",
                )}
              >
                <span
                  className={cn(
                    "grid size-10 shrink-0 place-items-center rounded-xl border transition-colors",
                    selected
                      ? "border-primary/25 bg-primary/12 text-primary"
                      : "border-border/70 bg-muted/45 text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  <ModeIcon className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {option.label}
                    {option.value === "review-only" ? (
                      <Badge
                        variant="secondary"
                        className="h-5 px-2 text-[10px] uppercase tracking-[0.12em]"
                      >
                        Recommended
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                <RadioGroupItem value={option.value} className="mt-2.5 shrink-0" />
              </label>
            );
          })}
        </RadioGroup>
        {saveError ? (
          <p className="text-xs text-destructive" role="alert">
            We couldn’t save your quiz choice. Please try again.
          </p>
        ) : null}
      </div>
    </div>
  );
});

function ConnectionPrivacyNote({ target }: { target: StudyBuddyConnectionTarget }) {
  const serviceName = target === "moodle" ? "Moodle" : target === "cis" ? "CIS" : "calendar";
  return (
    <Card className="border-emerald-500/20 bg-emerald-500/6 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-emerald-500/25 bg-background/80 text-emerald-500">
          <ShieldCheckIcon className="size-4" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold">
            {target === "calendar"
              ? "Your private link stays private"
              : "Your sign-in stays private"}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {target === "calendar"
              ? "Study Buddy keeps this link separate from Codex and only uses it to read your calendar for you. It is never included in shared usage data."
              : `Study Buddy keeps your ${serviceName} password separate from Codex and only uses it to sign in for you. It is never included in shared usage data.`}
          </p>
        </div>
      </div>
    </Card>
  );
}

function StepIntro({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: typeof ShieldCheckIcon;
}) {
  return (
    <div className="max-w-2xl">
      <div data-setup-intro-heading="true" className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl border bg-card shadow-sm">
          <Icon className="size-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 pt-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}
