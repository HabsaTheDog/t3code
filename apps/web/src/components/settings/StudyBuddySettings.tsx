import type {
  StudyBuddyConfiguration,
  StudyBuddyConfigurationPatch,
  StudyBuddyConnectionTarget,
  StudyBuddySecretPatch,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  AlertTriangleIcon,
  BotIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  GraduationCapIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  AudioWaveformIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { requestSetupRerun } from "../../setup/setupCoordinator";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { DraftTextarea } from "../ui/draft-textarea";
import { Input } from "../ui/input";
import { SecretInput } from "../ui/secret-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { QUIZ_ACCESS_MODE_OPTIONS, type QuizAccessMode } from "./StudyBuddySettings.logic";
import { registerTelemetrySecret, telemetry } from "../../telemetry/runtime";
import { featureProperties } from "../../telemetry/featureCatalog";
import { cn } from "../../lib/utils";
import { SpeechModelCard } from "../speech/SpeechModelCard";

type SecretField = "moodlePassword" | "cisPassword";
type SecretPatches = Partial<Record<SecretField, StudyBuddySecretPatch>>;
type ConnectionStatus = {
  state: "checking" | "success" | "failure";
  message?: string;
};

const EMPTY_CONFIG: StudyBuddyConfiguration = {
  exists: false,
  moodleUsername: "",
  moodleDashboardUrl: "",
  moodlePasswordConfigured: false,
  cisUsername: "",
  cisUrl: "",
  cisPasswordConfigured: false,
  calendarUrl: "",
  calendarUrlConfigured: false,
  quiz: {
    accessMode: "review-only",
    minimumTimeLimitMinutes: 10,
    minimumAttemptsLeft: 2,
    fillConfidenceThreshold: 0.85,
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "We couldn’t open your Study Buddy settings.";
}

function isDirtyConfig(
  draft: StudyBuddyConfiguration,
  config: StudyBuddyConfiguration,
  secretPatches: SecretPatches,
) {
  return (
    draft.moodleUsername !== config.moodleUsername ||
    draft.moodleDashboardUrl !== config.moodleDashboardUrl ||
    draft.cisUsername !== config.cisUsername ||
    draft.cisUrl !== config.cisUrl ||
    draft.calendarUrl !== config.calendarUrl ||
    draft.quiz.accessMode !== config.quiz.accessMode ||
    draft.quiz.minimumTimeLimitMinutes !== config.quiz.minimumTimeLimitMinutes ||
    draft.quiz.minimumAttemptsLeft !== config.quiz.minimumAttemptsLeft ||
    draft.quiz.fillConfidenceThreshold !== config.quiz.fillConfidenceThreshold ||
    Object.keys(secretPatches).length > 0
  );
}

export function StudyBuddySettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [config, setConfig] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [draft, setDraft] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [secretPatches, setSecretPatches] = useState<SecretPatches>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [changeGeneration, setChangeGeneration] = useState(0);
  const [secretResetVersion, setSecretResetVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<
    Partial<Record<StudyBuddyConnectionTarget, ConnectionStatus>>
  >({});
  const lastSavedGenerationRef = useRef(0);
  const lastFailedGenerationRef = useRef(-1);
  const latestGenerationRef = useRef(0);
  latestGenerationRef.current = changeGeneration;

  const markDirty = useCallback(() => {
    setChangeGeneration((generation) => generation + 1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await ensureLocalApi().server.getStudyBuddyConfiguration();
      setConfig(next);
      setDraft(next);
      setSecretPatches({});
      setSecretResetVersion((version) => version + 1);
      setChangeGeneration(0);
      lastSavedGenerationRef.current = 0;
      lastFailedGenerationRef.current = -1;
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (
      generationAtSave: number,
      draftAtSave: StudyBuddyConfiguration,
      secretPatchesAtSave: SecretPatches,
    ) => {
      setSaving(true);
      setError(null);
      const patch: StudyBuddyConfigurationPatch = {
        moodleUsername: draftAtSave.moodleUsername,
        moodleDashboardUrl: draftAtSave.moodleDashboardUrl,
        cisUsername: draftAtSave.cisUsername,
        cisUrl: draftAtSave.cisUrl,
        calendarUrl: draftAtSave.calendarUrl,
        quiz: draftAtSave.quiz,
        ...secretPatchesAtSave,
      };
      try {
        for (const secretPatch of Object.values(secretPatchesAtSave)) {
          if (secretPatch?.operation === "set") registerTelemetrySecret(secretPatch.value);
        }
        const next = await ensureLocalApi().server.updateStudyBuddyConfiguration({ patch });
        const hasNewerChanges = latestGenerationRef.current !== generationAtSave;
        setConfig(next);
        if (!hasNewerChanges) {
          setDraft(next);
          setSecretPatches({});
        }
        lastSavedGenerationRef.current = generationAtSave;
        lastFailedGenerationRef.current = -1;
        void telemetry.capture({
          event: "settings.changed",
          properties: { section: "study_buddy" },
        });
        void telemetry.capture({
          event: "feature.used",
          properties: featureProperties("settings.study_buddy"),
        });
      } catch (saveError) {
        const message = errorMessage(saveError);
        lastFailedGenerationRef.current = generationAtSave;
        setError(message);
        toastManager.add({
          type: "error",
          title: "We couldn’t save your changes",
          description: `${message} Please try again.`,
        });
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const hasDirtyChanges = useMemo(
    () => isDirtyConfig(draft, config, secretPatches),
    [config, draft, secretPatches],
  );

  useEffect(() => {
    if (loading || saving || !hasDirtyChanges) {
      return;
    }

    if (
      changeGeneration === lastSavedGenerationRef.current ||
      changeGeneration === lastFailedGenerationRef.current
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void save(changeGeneration, draft, secretPatches);
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [changeGeneration, draft, hasDirtyChanges, loading, save, saving, secretPatches]);

  const testConnection = useCallback(async (target: StudyBuddyConnectionTarget) => {
    setTestStatus((current) => ({ ...current, [target]: { state: "checking" } }));
    try {
      const result = await ensureLocalApi().server.testStudyBuddyConnection({ target });
      setTestStatus((current) => ({
        ...current,
        [target]: { state: result.status, message: result.message },
      }));
      toastManager.add({
        type: result.status === "success" ? "success" : "error",
        title: result.status === "success" ? "Everything works" : "We couldn’t connect",
        description: result.message,
      });
      void telemetry.capture({
        event: "study_connection.tested",
        properties: { target, outcome: result.status },
      });
    } catch (testError) {
      const message = errorMessage(testError);
      setTestStatus((current) => ({
        ...current,
        [target]: { state: "failure", message },
      }));
      toastManager.add({ type: "error", title: "We couldn’t connect", description: message });
      void telemetry.capture({
        event: "study_connection.tested",
        properties: { target, outcome: "failed" },
      });
    }
  }, []);

  return (
    <SettingsPageContainer>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Study Buddy</h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Connect your study services and choose how Study Buddy should help. Changes save
            automatically, and saved passwords stay hidden.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                disabled={loading || saving}
                aria-label="Reload Study Buddy settings"
                onClick={() => void load()}
              >
                <RefreshCwIcon className={`size-3 ${loading ? "animate-spin" : ""}`} />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Reload settings</TooltipPopup>
        </Tooltip>
      </div>

      {error ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>We couldn’t open these settings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Assistant" icon={<BotIcon className="size-3.5" />}>
        <SettingsRow
          title="Guided setup"
          description="Go through the step-by-step setup again. Your current choices and saved details will stay in place."
          control={
            <Button size="sm" variant="outline" onClick={requestSetupRerun}>
              Run setup again
            </Button>
          }
        />
        <SettingsRow
          title="How Study Buddy responds"
          description="Tell Study Buddy how you’d like it to explain things and work with you. This is used in new chats."
          resetAction={
            settings.personalityPrompt !== DEFAULT_UNIFIED_SETTINGS.personalityPrompt ? (
              <SettingResetButton
                label="personality"
                onClick={() =>
                  updateSettings({
                    personalityPrompt: DEFAULT_UNIFIED_SETTINGS.personalityPrompt,
                  })
                }
              />
            ) : null
          }
        >
          <div className="pt-3">
            <DraftTextarea
              value={settings.personalityPrompt}
              onCommit={(personalityPrompt) => updateSettings({ personalityPrompt })}
              placeholder="Example: Keep explanations short, use simple examples, and call me Alex."
              aria-label="Instructions for how Study Buddy should respond"
              className="min-h-36 resize-y text-xs leading-relaxed"
              spellCheck
            />
            <p className="mt-2 text-[11px] text-muted-foreground/70">
              Saved when you leave this box. Used the next time you start a chat.
            </p>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Voice input" icon={<AudioWaveformIcon className="size-3.5" />}>
        <SpeechModelCard compact surface="settings" />
      </SettingsSection>

      <SettingsSection title="Moodle" icon={<GraduationCapIcon className="size-3.5" />}>
        <SettingsRow
          title="Moodle website"
          description="The Moodle page you normally use to see your courses."
          control={
            <ConnectionCheckButton
              target="moodle"
              status={testStatus.moodle}
              disabled={loading}
              onTest={testConnection}
            />
          }
        >
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.moodleDashboardUrl}
              disabled={loading}
              placeholder="https://moodle.technikum-wien.at"
              onChange={(event) =>
                setDraft((current) => {
                  markDirty();
                  return {
                    ...current,
                    moodleDashboardUrl: event.currentTarget.value,
                  };
                })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Moodle username"
          description="The username you use to sign in to Moodle."
        >
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.moodleUsername}
              disabled={loading}
              autoComplete="username"
              placeholder="Your student username"
              onChange={(event) =>
                setDraft((current) => {
                  markDirty();
                  return { ...current, moodleUsername: event.currentTarget.value };
                })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Moodle password"
          description={
            config.moodlePasswordConfigured
              ? "Your password is saved. Enter a new one only if you want to replace it."
              : "Enter your Moodle password."
          }
          status={config.moodlePasswordConfigured ? <ConfiguredStatus /> : undefined}
        >
          <SecretInput
            key={`moodle-password-${secretResetVersion}`}
            label="Moodle password"
            resetKey={`moodle-password-${secretResetVersion}`}
            disabled={loading}
            placeholder={
              config.moodlePasswordConfigured
                ? "Password saved — enter to replace"
                : "Enter password"
            }
            onValueChange={(value) =>
              setSecretPatches((current) => {
                if (!value) {
                  const next = { ...current };
                  delete next.moodlePassword;
                  return next;
                }
                markDirty();
                return {
                  ...current,
                  moodlePassword: { operation: "set", value },
                };
              })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="CIS" icon={<KeyRoundIcon className="size-3.5" />}>
        <SettingsRow
          title="CIS website"
          description="The CIS page you normally use for schedules, rooms, exams, and study information."
          control={
            <ConnectionCheckButton
              target="cis"
              status={testStatus.cis}
              disabled={loading}
              onTest={testConnection}
            />
          }
        >
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.cisUrl}
              disabled={loading}
              placeholder="https://cis.technikum-wien.at"
              onChange={(event) =>
                setDraft((current) => {
                  markDirty();
                  return { ...current, cisUrl: event.currentTarget.value };
                })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="CIS username"
          description="Leave this empty if you use the same username as Moodle."
        >
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.cisUsername}
              disabled={loading}
              autoComplete="username"
              placeholder="Same as Moodle"
              onChange={(event) =>
                setDraft((current) => {
                  markDirty();
                  return { ...current, cisUsername: event.currentTarget.value };
                })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="CIS password"
          description={
            config.cisPasswordConfigured
              ? "Your password is saved. Enter a new one only if you want to replace it."
              : "Enter your CIS password."
          }
          status={config.cisPasswordConfigured ? <ConfiguredStatus /> : undefined}
        >
          <SecretInput
            key={`cis-password-${secretResetVersion}`}
            label="CIS password"
            resetKey={`cis-password-${secretResetVersion}`}
            disabled={loading}
            placeholder={
              config.cisPasswordConfigured ? "Password saved — enter to replace" : "Enter password"
            }
            onValueChange={(value) =>
              setSecretPatches((current) => {
                if (!value) {
                  const next = { ...current };
                  delete next.cisPassword;
                  return next;
                }
                markDirty();
                return {
                  ...current,
                  cisPassword: { operation: "set", value },
                };
              })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Calendar" icon={<CalendarDaysIcon className="size-3.5" />}>
        <SettingsRow
          title="Private calendar link"
          description="Copy this link from your calendar service. Study Buddy uses it to check upcoming classes, exams, and deadlines."
          control={
            <ConnectionCheckButton
              target="calendar"
              status={testStatus.calendar}
              disabled={loading}
              onTest={testConnection}
            />
          }
        >
          <div className="pt-3">
            <Input
              nativeInput
              type="url"
              value={draft.calendarUrl}
              disabled={loading}
              placeholder="https://…/calendar.ics"
              aria-label="Private calendar link"
              onChange={(event) =>
                setDraft((current) => {
                  markDirty();
                  return { ...current, calendarUrl: event.currentTarget.value };
                })
              }
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Quiz safety" icon={<ShieldCheckIcon className="size-3.5" />}>
        <SettingsRow
          title="Quiz help"
          description="Choose how Study Buddy may help with Moodle quizzes. Only you can submit a quiz."
          control={
            <Select
              value={draft.quiz.accessMode}
              onValueChange={(value) => {
                if (!value) return;
                setDraft((current) => {
                  markDirty();
                  return {
                    ...current,
                    quiz: { ...current.quiz, accessMode: value as QuizAccessMode },
                  };
                });
              }}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Quiz help level">
                <SelectValue>
                  {
                    QUIZ_ACCESS_MODE_OPTIONS.find(
                      (option) => option.value === draft.quiz.accessMode,
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {QUIZ_ACCESS_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ConfiguredStatus() {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-success">
      <CheckCircle2Icon className="size-3" />
      Configured
    </span>
  );
}

function ConnectionCheckButton({
  target,
  status,
  disabled,
  onTest,
}: {
  target: StudyBuddyConnectionTarget;
  status: ConnectionStatus | undefined;
  disabled: boolean;
  onTest: (target: StudyBuddyConnectionTarget) => Promise<void>;
}) {
  const checking = status?.state === "checking";
  const label = checking
    ? "Checking…"
    : status?.state === "success"
      ? "Connected"
      : status?.state === "failure"
        ? "Try again"
        : "Check connection";
  const button = (
    <Button
      size="sm"
      variant="outline"
      className={cn(
        status?.state === "success" && "border-success/40 text-success hover:text-success",
        status?.state === "failure" &&
          "border-destructive/40 text-destructive hover:text-destructive",
      )}
      disabled={disabled || checking}
      aria-label={`Test ${target === "cis" ? "CIS" : target} connection`}
      onClick={() => void onTest(target)}
    >
      {checking ? (
        <Spinner className="size-3.5" />
      ) : status?.state === "failure" ? (
        <XCircleIcon className="size-3.5" />
      ) : (
        <CheckCircle2Icon className="size-3.5" />
      )}
      {label}
    </Button>
  );

  if (!status?.message) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{status.message}</TooltipPopup>
    </Tooltip>
  );
}
