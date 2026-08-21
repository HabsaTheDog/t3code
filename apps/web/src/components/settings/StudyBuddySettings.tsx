import type {
  StudyBuddyConfiguration,
  StudyBuddyConfigurationPatch,
  StudyBuddySourceInventory,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  AlertTriangleIcon,
  BotIcon,
  DatabaseZapIcon,
  MailIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  AudioWaveformIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { requestSetupRerun } from "../../setup/setupCoordinator";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { DraftTextarea } from "../ui/draft-textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { QUIZ_ACCESS_MODE_OPTIONS, type QuizAccessMode } from "./StudyBuddySettings.logic";
import { telemetry } from "../../telemetry/runtime";
import { featureProperties } from "../../telemetry/featureCatalog";
import { SpeechModelCard } from "../speech/SpeechModelCard";
import { SourceInventory } from "./SourceInventory";
import { EmailSafetySettings } from "./EmailSafetySettings";

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

function isDirtyConfig(draft: StudyBuddyConfiguration, config: StudyBuddyConfiguration) {
  return (
    draft.quiz.accessMode !== config.quiz.accessMode ||
    draft.quiz.minimumTimeLimitMinutes !== config.quiz.minimumTimeLimitMinutes ||
    draft.quiz.minimumAttemptsLeft !== config.quiz.minimumAttemptsLeft ||
    draft.quiz.fillConfidenceThreshold !== config.quiz.fillConfidenceThreshold
  );
}

export function StudyBuddySettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [config, setConfig] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [draft, setDraft] = useState<StudyBuddyConfiguration>(EMPTY_CONFIG);
  const [sourceInventory, setSourceInventory] = useState<StudyBuddySourceInventory | null>(null);
  const [sourceDialogRequested, setSourceDialogRequested] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [changeGeneration, setChangeGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
      const [next, nextInventory] = await Promise.all([
        ensureLocalApi().server.getStudyBuddyConfiguration(),
        ensureLocalApi().server.getStudyBuddySourceInventory(),
      ]);
      setConfig(next);
      setDraft(next);
      setSourceInventory(nextInventory);
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
    async (generationAtSave: number, draftAtSave: StudyBuddyConfiguration) => {
      setSaving(true);
      setError(null);
      const patch: StudyBuddyConfigurationPatch = {
        quiz: draftAtSave.quiz,
      };
      try {
        const next = await ensureLocalApi().server.updateStudyBuddyConfiguration({ patch });
        const hasNewerChanges = latestGenerationRef.current !== generationAtSave;
        setConfig(next);
        if (!hasNewerChanges) {
          setDraft(next);
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

  const hasDirtyChanges = useMemo(() => isDirtyConfig(draft, config), [config, draft]);

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
      void save(changeGeneration, draft);
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [changeGeneration, draft, hasDirtyChanges, loading, save, saving]);

  return (
    <SettingsPageContainer>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Study Buddy</h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Connect the places Study Buddy may learn from and choose how it should help. Source
            changes are saved explicitly, and saved passwords stay hidden.
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

      <SettingsSection
        title="Sources"
        icon={<DatabaseZapIcon className="size-3.5" />}
        headerAction={
          sourceInventory && sourceInventory.sources.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!sourceInventory}
              onClick={() => setSourceDialogRequested((request) => request + 1)}
            >
              <PlusIcon className="size-3.5" />
              Add another source
            </Button>
          ) : null
        }
      >
        {sourceInventory ? (
          <SourceInventory
            inventory={sourceInventory}
            addRequest={sourceDialogRequested}
            onInventoryChange={setSourceInventory}
          />
        ) : (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            Loading sources…
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Email access" icon={<MailIcon className="size-3.5" />}>
        <EmailSafetySettings inventory={sourceInventory} onInventoryChange={setSourceInventory} />
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
