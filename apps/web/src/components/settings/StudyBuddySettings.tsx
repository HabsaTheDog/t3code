import type {
  StudyBuddyConfiguration,
  StudyBuddyConfigurationPatch,
  StudyBuddyConnectionTarget,
  StudyBuddySecretPatch,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  BrainCircuitIcon,
  CalendarCheckIcon,
  CheckCircle2Icon,
  GraduationCapIcon,
  KeyRoundIcon,
  PencilLineIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "../ui/secret-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { QUIZ_ACCESS_MODE_OPTIONS, type QuizAccessMode } from "./StudyBuddySettings.logic";
import { registerTelemetrySecret, telemetry } from "../../telemetry/runtime";

type SecretField = "moodlePassword" | "cisPassword" | "calendarUrlSecret";
type SecretPatches = Partial<Record<SecretField, StudyBuddySecretPatch>>;
type SyncState = "loading" | "saved" | "dirty" | "saving" | "error";

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
  return error instanceof Error ? error.message : "Study Buddy settings are unavailable.";
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
    draft.quiz.accessMode !== config.quiz.accessMode ||
    draft.quiz.minimumTimeLimitMinutes !== config.quiz.minimumTimeLimitMinutes ||
    draft.quiz.minimumAttemptsLeft !== config.quiz.minimumAttemptsLeft ||
    draft.quiz.fillConfidenceThreshold !== config.quiz.fillConfidenceThreshold ||
    Object.keys(secretPatches).length > 0
  );
}

function SaveStatusBadge({ state }: { state: SyncState }) {
  const content = (() => {
    switch (state) {
      case "loading":
        return {
          icon: <Spinner className="size-3" />,
          label: "Loading",
          variant: "secondary" as const,
        };
      case "saving":
        return {
          icon: <Spinner className="size-3" />,
          label: "Saving",
          variant: "secondary" as const,
        };
      case "dirty":
        return {
          icon: <PencilLineIcon className="size-3" />,
          label: "Unsaved changes",
          variant: "outline" as const,
        };
      case "error":
        return {
          icon: <AlertTriangleIcon className="size-3" />,
          label: "Save failed",
          variant: "destructive" as const,
        };
      case "saved":
      default:
        return {
          icon: <CheckCircle2Icon className="size-3" />,
          label: "Saved",
          variant: "success" as const,
        };
    }
  })();

  return (
    <Badge className="gap-1.5" variant={content.variant}>
      {content.icon}
      {content.label}
    </Badge>
  );
}

export function StudyBuddySettingsPanel() {
  const [config, setConfig] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [draft, setDraft] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [secretPatches, setSecretPatches] = useState<SecretPatches>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [changeGeneration, setChangeGeneration] = useState(0);
  const [secretResetVersion, setSecretResetVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Partial<Record<StudyBuddyConnectionTarget, string>>>(
    {},
  );
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
        toastManager.add({ type: "success", title: "Study Buddy settings saved" });
      } catch (saveError) {
        const message = errorMessage(saveError);
        lastFailedGenerationRef.current = generationAtSave;
        setError(message);
        toastManager.add({
          type: "error",
          title: "Study Buddy settings failed",
          description: message,
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

  const syncState: SyncState = loading
    ? "loading"
    : saving
      ? "saving"
      : error
        ? "error"
        : hasDirtyChanges
          ? "dirty"
          : "saved";

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
    setTestStatus((current) => ({ ...current, [target]: "Checking…" }));
    try {
      const result = await ensureLocalApi().server.testStudyBuddyConnection({ target });
      setTestStatus((current) => ({ ...current, [target]: result.message }));
      void telemetry.capture({
        event: "study_connection.tested",
        properties: { target, outcome: result.status },
      });
    } catch (testError) {
      setTestStatus((current) => ({ ...current, [target]: errorMessage(testError) }));
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
            Passwords stay hidden by default and can be revealed while editing. Changes save
            automatically after you pause typing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading || saving}
            onClick={() => void load()}
          >
            <RefreshCwIcon className="size-3.5" />
            Reload
          </Button>
          <SaveStatusBadge state={syncState} />
        </div>
      </div>

      {error ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>Study Buddy settings unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Model support" icon={<BrainCircuitIcon className="size-3.5" />}>
        <SettingsRow
          title="Study Buddy pipeline"
          description="Study Buddy currently runs its internal Moodle/CIS pipeline through Codex. Other providers remain available for regular chat."
        >
          <div className="flex flex-wrap gap-2 pt-3">
            <Badge variant="default">Codex available</Badge>
            <Badge variant="secondary">Claude coming soon</Badge>
            <Badge variant="secondary">Cursor coming soon</Badge>
            <Badge variant="secondary">OpenCode coming soon</Badge>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Accounts" icon={<KeyRoundIcon className="size-3.5" />}>
        <SettingsRow title="Moodle username" description="Your Technikum Moodle account name.">
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.moodleUsername}
              disabled={loading}
              autoComplete="username"
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
          description="Hidden by default. Use the icon to reveal what you type."
        >
          <SecretInput
            key={`moodle-password-${secretResetVersion}`}
            label="Moodle password"
            resetKey={`moodle-password-${secretResetVersion}`}
            disabled={loading}
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
        <SettingsRow title="CIS username" description="Leave empty to use the Moodle username.">
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.cisUsername}
              disabled={loading}
              autoComplete="username"
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
          description="Hidden by default. Use the icon to reveal what you type."
        >
          <SecretInput
            key={`cis-password-${secretResetVersion}`}
            label="CIS password"
            resetKey={`cis-password-${secretResetVersion}`}
            disabled={loading}
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

      <SettingsSection title="Sources" icon={<GraduationCapIcon className="size-3.5" />}>
        <SettingsRow title="Moodle URL" description="Dashboard, course, or activity URL.">
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.moodleDashboardUrl}
              disabled={loading}
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
        <SettingsRow title="CIS URL" description="Schedules, rooms, exams, and administration.">
          <div className="pt-3">
            <Input
              nativeInput
              value={draft.cisUrl}
              disabled={loading}
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
          title="Calendar URL"
          description="Write-only private feed URL. The saved value is never returned to the browser."
        >
          <SecretInput
            key={`calendar-url-${secretResetVersion}`}
            label="Calendar URL"
            resetKey={`calendar-url-${secretResetVersion}`}
            disabled={loading}
            placeholder={
              config.calendarUrlConfigured ? "Configured — enter to replace" : "Enter URL"
            }
            onValueChange={(value) =>
              setSecretPatches((current) => {
                if (!value) {
                  const next = { ...current };
                  delete next.calendarUrlSecret;
                  return next;
                }
                markDirty();
                return {
                  ...current,
                  calendarUrlSecret: { operation: "set", value },
                };
              })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Quiz safety" icon={<ShieldCheckIcon className="size-3.5" />}>
        <SettingsRow
          title="Access mode"
          description="Final Moodle quiz submission remains blocked in every mode."
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
              <SelectTrigger className="w-full sm:w-52" aria-label="Quiz access mode">
                <SelectValue />
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

      <SettingsSection title="Connection checks" icon={<CalendarCheckIcon className="size-3.5" />}>
        {(["moodle", "cis", "calendar"] as const).map((target) => (
          <SettingsRow
            key={target}
            title={target === "cis" ? "CIS" : `${target[0]?.toUpperCase()}${target.slice(1)}`}
            description={
              testStatus[target] ??
              (target === "calendar"
                ? "Fetches HTTPS and parses iCalendar data."
                : "Checks login and page reachability without starting quizzes.")
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void testConnection(target)}
              >
                {testStatus[target]?.startsWith("Checking") ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <CheckCircle2Icon className="size-3.5" />
                )}
                Test
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
