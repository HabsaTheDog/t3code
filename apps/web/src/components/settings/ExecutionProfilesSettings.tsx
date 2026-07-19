import type {
  StudyBuddyCustomExecutionProfile,
  StudyBuddyExecutionProfileDefinition,
  StudyBuddyProfileIcon,
  StudyBuddyProfileRoles,
  StudyBuddyReasoningEffort,
} from "@t3tools/contracts";
import { ProviderInstanceId, STUDY_BUDDY_MAX_CUSTOM_PROFILES } from "@t3tools/contracts";
import {
  allStudyBuddyProfiles,
  baseExecutionProfile,
  duplicateStudyBuddyProfile,
  resolveStudyBuddyProfileFromSettings,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  GaugeIcon,
  PinIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import {
  STUDY_BUDDY_PROFILE_ICON_OPTIONS,
  StudyBuddyProfileIconView,
} from "../studyBuddyProfileIcons";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer } from "./settingsLayout";

const REASONING_OPTIONS: ReadonlyArray<{
  value: StudyBuddyReasoningEffort;
  label: string;
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

const WORKER_ROLES: ReadonlyArray<{
  key: Exclude<keyof StudyBuddyProfileRoles, "coordinator">;
  label: string;
  description: string;
}> = [
  {
    key: "contentAnalyzer",
    label: "Content analyst",
    description: "Turns source evidence into grounded, structured learning content.",
  },
  {
    key: "quizSolver",
    label: "Quiz solver",
    description: "Reasons about each quiz question and returns a confidence-scored answer plan.",
  },
  {
    key: "artifactPlanner",
    label: "Artifact planner",
    description: "Plans structure, visuals, calculations, and interactions.",
  },
  {
    key: "artifactBuilder",
    label: "Artifact builder",
    description: "Builds Typst documents and interactive HTML artifacts.",
  },
  {
    key: "qualityReviewer",
    label: "Quality reviewer",
    description: "Reviews factual grounding, pedagogy, and usability after technical checks.",
  },
];

export function ExecutionProfilesSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const resolvedDefault = resolveStudyBuddyProfileFromSettings(settings);
  const [selectedId, setSelectedId] = useState(resolvedDefault.id);
  const [draftProfile, setDraftProfile] = useState<StudyBuddyCustomExecutionProfile | null>(null);
  const profiles = allStudyBuddyProfiles(settings.studyBuddyCustomExecutionProfiles);
  const selectedProfile =
    (draftProfile?.id === selectedId ? draftProfile : null) ??
    profiles.find((profile) => profile.id === selectedId) ??
    resolvedDefault;
  const customCount = settings.studyBuddyCustomExecutionProfiles.length;
  const knownModels = useMemo(
    () => [
      ...new Set(
        serverProviders
          .filter((provider) => provider.driver === "codex")
          .flatMap((provider) => provider.models.map((model) => model.slug)),
      ),
    ],
    [serverProviders],
  );

  const setDefault = (profile: StudyBuddyExecutionProfileDefinition) => {
    updateSettings({
      studyBuddyExecutionProfileId: profile.id,
      studyBuddyExecutionProfile: baseExecutionProfile(profile),
    });
  };
  const createBlankProfile = () => {
    if (customCount >= STUDY_BUDDY_MAX_CUSTOM_PROFILES) return;
    const blankWorker = {
      model: "",
      reasoningEffort: "medium" as const,
      retryModel: "",
      retryReasoningEffort: "high" as const,
    };
    const profile: StudyBuddyCustomExecutionProfile = {
      id: `custom-${randomUUID()}`,
      name: "Untitled profile",
      description: "",
      kind: "custom",
      icon: "book-open",
      roles: {
        coordinator: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "",
          reasoningEffort: "medium",
        },
        contentAnalyzer: { ...blankWorker },
        quizSolver: { ...blankWorker },
        artifactPlanner: { ...blankWorker },
        artifactBuilder: { ...blankWorker },
        qualityReviewer: { ...blankWorker },
      },
    };
    setDraftProfile(profile);
    setSelectedId(profile.id);
  };
  const saveDraftProfile = () => {
    if (!draftProfile || !isCompleteProfile(draftProfile)) return;
    updateSettings({
      studyBuddyCustomExecutionProfiles: [
        ...settings.studyBuddyCustomExecutionProfiles,
        draftProfile,
      ],
    });
    setDraftProfile(null);
  };
  const replaceCustomProfile = (nextProfile: StudyBuddyCustomExecutionProfile) => {
    updateSettings({
      studyBuddyCustomExecutionProfiles: settings.studyBuddyCustomExecutionProfiles.map((profile) =>
        profile.id === nextProfile.id ? nextProfile : profile,
      ),
    });
  };
  const duplicateProfile = (source: StudyBuddyExecutionProfileDefinition) => {
    if (customCount >= STUDY_BUDDY_MAX_CUSTOM_PROFILES) return;
    const copy = duplicateStudyBuddyProfile(source, `custom-${randomUUID()}`);
    updateSettings({
      studyBuddyCustomExecutionProfiles: [...settings.studyBuddyCustomExecutionProfiles, copy],
    });
    setDraftProfile(null);
    setSelectedId(copy.id);
  };
  const deleteProfile = (profile: StudyBuddyCustomExecutionProfile) => {
    const nextProfiles = settings.studyBuddyCustomExecutionProfiles.filter(
      (entry) => entry.id !== profile.id,
    );
    if (draftProfile?.id === profile.id) {
      setDraftProfile(null);
      setSelectedId(resolvedDefault.id);
      return;
    }
    const wasDefault = resolvedDefault.id === profile.id;
    updateSettings({
      studyBuddyCustomExecutionProfiles: nextProfiles,
      ...(wasDefault
        ? { studyBuddyExecutionProfileId: "balanced", studyBuddyExecutionProfile: "balanced" }
        : {}),
    });
    setSelectedId(wasDefault ? "balanced" : resolvedDefault.id);
  };

  return (
    <SettingsPageContainer className="max-w-5xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GaugeIcon className="size-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold tracking-tight">Execution profiles</h1>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Set the profile new chats start with. Existing chats keep their own profile. Built-ins
            are read-only; duplicate one to customize it.
          </p>
        </div>
        <Button
          size="sm"
          disabled={customCount >= STUDY_BUDDY_MAX_CUSTOM_PROFILES}
          onClick={createBlankProfile}
        >
          <PlusIcon className="size-3.5" /> New profile
        </Button>
      </div>

      <div className="grid min-h-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="self-start rounded-2xl border bg-card p-2 shadow-sm/4">
          {settings.studyBuddyCustomExecutionProfiles.length > 0 || draftProfile ? (
            <ProfileGroup label={`My profiles · ${customCount}/${STUDY_BUDDY_MAX_CUSTOM_PROFILES}`}>
              {draftProfile ? (
                <ProfileButton
                  profile={draftProfile}
                  isDefault={false}
                  selected={draftProfile.id === selectedProfile.id}
                  onClick={() => setSelectedId(draftProfile.id)}
                />
              ) : null}
              {settings.studyBuddyCustomExecutionProfiles.map((profile) => (
                <ProfileButton
                  key={profile.id}
                  profile={profile}
                  isDefault={profile.id === resolvedDefault.id}
                  selected={profile.id === selectedProfile.id}
                  onClick={() => setSelectedId(profile.id)}
                />
              ))}
            </ProfileGroup>
          ) : (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              Create a blank profile or duplicate a built-in one.
            </div>
          )}
          <div className="my-2 h-px bg-border/70" />
          <ProfileGroup label="Built in">
            {STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => (
              <ProfileButton
                key={profile.id}
                profile={profile}
                isDefault={profile.id === resolvedDefault.id}
                selected={profile.id === selectedProfile.id}
                onClick={() => setSelectedId(profile.id)}
              />
            ))}
          </ProfileGroup>
        </aside>

        <ProfileEditor
          profile={selectedProfile}
          isDefault={selectedProfile.id === resolvedDefault.id}
          knownModels={knownModels}
          onSetDefault={() => setDefault(selectedProfile)}
          onDuplicate={() => duplicateProfile(selectedProfile)}
          {...(selectedProfile.kind === "custom"
            ? {
                onDelete: () => deleteProfile(selectedProfile as StudyBuddyCustomExecutionProfile),
                onChange: (profile: StudyBuddyExecutionProfileDefinition) =>
                  draftProfile?.id === profile.id
                    ? setDraftProfile(profile as StudyBuddyCustomExecutionProfile)
                    : replaceCustomProfile(profile as StudyBuddyCustomExecutionProfile),
                ...(draftProfile?.id === selectedProfile.id
                  ? { onSave: saveDraftProfile, saveDisabled: !isCompleteProfile(draftProfile) }
                  : {}),
              }
            : {})}
          duplicateDisabled={customCount >= STUDY_BUDDY_MAX_CUSTOM_PROFILES}
        />
      </div>
    </SettingsPageContainer>
  );
}

function ProfileGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ProfileButton(props: {
  profile: StudyBuddyExecutionProfileDefinition;
  isDefault: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
        props.selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
      }`}
    >
      <StudyBuddyProfileIconView
        icon={props.profile.icon}
        className="size-3.5 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{props.profile.name}</span>
      {props.isDefault ? <CheckIcon className="size-3.5 text-emerald-500" /> : null}
    </button>
  );
}

function isCompleteProfile(profile: StudyBuddyCustomExecutionProfile): boolean {
  const workers = WORKER_ROLES.map((role) => profile.roles[role.key]);
  return (
    profile.name.trim().length > 0 &&
    profile.roles.coordinator.model.trim().length > 0 &&
    workers.every((worker) => worker.model.trim().length > 0 && worker.retryModel.trim().length > 0)
  );
}

function normalizeProfileName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 40);
}

function ProfileEditor(props: {
  profile: StudyBuddyExecutionProfileDefinition;
  isDefault: boolean;
  knownModels: ReadonlyArray<string>;
  duplicateDisabled: boolean;
  onSetDefault: () => void;
  onDuplicate: () => void;
  onSave?: () => void;
  saveDisabled?: boolean;
  onDelete?: () => void;
  onChange?: (profile: StudyBuddyExecutionProfileDefinition) => void;
}) {
  const editable = props.profile.kind === "custom" && props.onChange;
  const [editableName, setEditableName] = useState(props.profile.name);
  useEffect(() => setEditableName(props.profile.name), [props.profile.id]);
  const changeProfile = (patch: Partial<StudyBuddyExecutionProfileDefinition>) =>
    props.onChange?.({ ...props.profile, ...patch });
  const changeRoles = (roles: StudyBuddyProfileRoles) => changeProfile({ roles });
  const roleModels = (current: string) =>
    [...new Set([current, ...props.knownModels])].filter((model) => model.length > 0);

  return (
    <section className="@container/profile overflow-hidden rounded-2xl border bg-card shadow-sm/4">
      <header className="border-b border-border/70 p-4 sm:p-5">
        <div className="flex flex-col gap-3 @4xl/profile:flex-row @4xl/profile:items-start @4xl/profile:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {editable ? (
                <ProfileIconControl
                  value={props.profile.icon ?? "book-open"}
                  onChange={(icon) => changeProfile({ icon })}
                />
              ) : (
                <span className="flex size-8 items-center justify-center rounded-lg border bg-background">
                  <StudyBuddyProfileIconView icon={props.profile.icon} className="size-4" />
                </span>
              )}
              {editable ? (
                <Input
                  nativeInput
                  size="sm"
                  className="min-w-40 flex-1 font-semibold @sm/profile:max-w-sm"
                  value={editableName}
                  maxLength={40}
                  aria-label="Profile name"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setEditableName(value);
                    if (value.trim().length > 0 && !/\s$/.test(value)) {
                      changeProfile({ name: value });
                    }
                  }}
                  onBlur={() => {
                    const normalized = normalizeProfileName(editableName);
                    if (!normalized) {
                      setEditableName(props.profile.name);
                      return;
                    }
                    setEditableName(normalized);
                    changeProfile({ name: normalized });
                  }}
                />
              ) : (
                <h2 className="text-base font-semibold">{props.profile.name}</h2>
              )}
              <Badge variant={props.profile.kind === "built-in" ? "secondary" : "outline"}>
                {props.profile.kind === "built-in" ? "Built in" : "Custom"}
              </Badge>
            </div>
            {editable ? (
              <Textarea
                className="mt-2 w-full @3xl/profile:max-w-xl"
                size="sm"
                value={props.profile.description}
                maxLength={180}
                aria-label="Profile description"
                placeholder="Describe when this profile should be used."
                onChange={(event) => changeProfile({ description: event.currentTarget.value })}
              />
            ) : (
              <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                {props.profile.description}
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2 @4xl/profile:shrink-0">
            {props.onSave ? (
              <Button size="sm" disabled={props.saveDisabled} onClick={props.onSave}>
                <SaveIcon className="size-3.5" /> Save profile
              </Button>
            ) : props.isDefault ? (
              <span
                className={buttonVariants({
                  size: "sm",
                  variant: "outline",
                  className:
                    "min-w-32 cursor-default border-success/20 bg-success/8 text-success-foreground shadow-none before:shadow-none dark:bg-success/16",
                })}
              >
                <PinIcon className="size-3.5" /> Default
              </span>
            ) : (
              <Button size="sm" onClick={props.onSetDefault}>
                <PinIcon className="size-3.5" /> Set as default
              </Button>
            )}
            {!props.onSave ? (
              <Button
                size="sm"
                variant="outline"
                disabled={props.duplicateDisabled}
                onClick={props.onDuplicate}
              >
                <CopyIcon className="size-3.5" /> Duplicate
              </Button>
            ) : null}
            {props.onDelete ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={props.onSave ? "Discard profile" : "Delete profile"}
                onClick={props.onDelete}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="hidden border-b border-border/60 bg-muted/20 px-5 py-3 @3xl/profile:grid @3xl/profile:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          Agent role
        </div>
        <div className="grid grid-cols-2">
          <div className="px-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em]">
              Primary models
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Used for the first attempt</p>
          </div>
          <div className="border-l border-border/70 px-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em]">
              Fallback models
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Used after a failed attempt</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border/60">
        <RoleRow
          index={1}
          label="Coordinator"
          description="Routes the request and supervises the complete workflow."
          primary={
            <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(6.5rem,0.75fr)] gap-2">
              <Field label="Model">
                <ModelControl
                  editable={Boolean(editable)}
                  value={props.profile.roles.coordinator.model}
                  models={roleModels(props.profile.roles.coordinator.model)}
                  onChange={(model) =>
                    changeRoles({
                      ...props.profile.roles,
                      coordinator: { ...props.profile.roles.coordinator, model },
                    })
                  }
                />
              </Field>
              <Field label="Thinking">
                <ReasoningControl
                  editable={Boolean(editable)}
                  value={props.profile.roles.coordinator.reasoningEffort}
                  onChange={(reasoningEffort) =>
                    changeRoles({
                      ...props.profile.roles,
                      coordinator: { ...props.profile.roles.coordinator, reasoningEffort },
                    })
                  }
                />
              </Field>
            </div>
          }
        />

        {WORKER_ROLES.map((role, roleIndex) => {
          const value = props.profile.roles[role.key];
          return (
            <RoleRow
              key={role.key}
              index={roleIndex + 2}
              label={role.label}
              description={role.description}
              primary={
                <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(6.5rem,0.75fr)] gap-2">
                  <Field label="Model">
                    <ModelControl
                      editable={Boolean(editable)}
                      value={value.model}
                      models={roleModels(value.model)}
                      onChange={(model) =>
                        changeRoles({
                          ...props.profile.roles,
                          [role.key]: { ...value, model },
                        })
                      }
                    />
                  </Field>
                  <Field label="Thinking">
                    <ReasoningControl
                      editable={Boolean(editable)}
                      value={value.reasoningEffort}
                      onChange={(reasoningEffort) =>
                        changeRoles({
                          ...props.profile.roles,
                          [role.key]: { ...value, reasoningEffort },
                        })
                      }
                    />
                  </Field>
                </div>
              }
              fallback={
                <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(6.5rem,0.75fr)] gap-2">
                  <Field label="Model">
                    <ModelControl
                      editable={Boolean(editable)}
                      value={value.retryModel}
                      models={roleModels(value.retryModel)}
                      onChange={(retryModel) =>
                        changeRoles({
                          ...props.profile.roles,
                          [role.key]: { ...value, retryModel },
                        })
                      }
                    />
                  </Field>
                  <Field label="Thinking">
                    <ReasoningControl
                      editable={Boolean(editable)}
                      value={value.retryReasoningEffort}
                      onChange={(retryReasoningEffort) =>
                        changeRoles({
                          ...props.profile.roles,
                          [role.key]: { ...value, retryReasoningEffort },
                        })
                      }
                    />
                  </Field>
                </div>
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function RoleRow(props: {
  index: number;
  label: string;
  description: string;
  primary: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <div className="grid gap-3 p-4 sm:p-5 @3xl/profile:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-[10px] text-muted-foreground">
          {props.index}
        </span>
        <div>
          <h3 className="text-[13px] font-semibold">{props.label}</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{props.description}</p>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 @2xl/profile:grid-cols-2 @2xl/profile:gap-0">
        <div className="min-w-0 @2xl/profile:px-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground @3xl/profile:hidden">
            Primary model
          </div>
          {props.primary}
        </div>
        {props.fallback ? (
          <div className="min-w-0 border-t border-border/70 pt-3 @2xl/profile:border-l @2xl/profile:border-t-0 @2xl/profile:px-4 @2xl/profile:pt-0">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground @3xl/profile:hidden">
              Fallback model
            </div>
            {props.fallback}
          </div>
        ) : (
          <div
            className="hidden min-h-12 border-l border-border/70 @2xl/profile:block"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

function ProfileIconControl(props: {
  value: StudyBuddyProfileIcon;
  onChange: (icon: StudyBuddyProfileIcon) => void;
}) {
  return (
    <Select value={props.value} onValueChange={(value) => value && props.onChange(value)}>
      <SelectTrigger size="xs" className="!w-12 !min-w-12 px-2" aria-label="Profile icon">
        <StudyBuddyProfileIconView icon={props.value} className="size-4" />
      </SelectTrigger>
      <SelectPopup popupClassName="min-w-48">
        {STUDY_BUDDY_PROFILE_ICON_OPTIONS.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            <span className="flex items-center gap-2">
              <option.icon className="size-4 text-muted-foreground" />
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function ModelControl(props: {
  editable: boolean;
  value: string;
  models: ReadonlyArray<string>;
  onChange: (model: string) => void;
}) {
  if (!props.editable)
    return <ReadOnlyValue value={props.value || "Not selected"} icon={<BotIcon />} />;
  return (
    <Select value={props.value || null} onValueChange={(value) => value && props.onChange(value)}>
      <SelectTrigger size="xs" className="!min-w-0 w-full">
        <SelectValue placeholder="Choose model" />
      </SelectTrigger>
      <SelectPopup>
        {props.models.map((model) => (
          <SelectItem key={model} value={model}>
            {model}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ReasoningControl(props: {
  editable: boolean;
  value: StudyBuddyReasoningEffort;
  onChange: (effort: StudyBuddyReasoningEffort) => void;
}) {
  if (!props.editable) {
    return (
      <ReadOnlyValue
        value={
          REASONING_OPTIONS.find((option) => option.value === props.value)?.label ?? props.value
        }
      />
    );
  }
  return (
    <Select
      value={props.value}
      onValueChange={(value) => value && props.onChange(value as StudyBuddyReasoningEffort)}
    >
      <SelectTrigger size="xs" className="!min-w-0 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {REASONING_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ReadOnlyValue({ value, icon }: { value: string; icon?: ReactNode }) {
  return (
    <span className="flex min-h-6 min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-muted/45 px-2 text-xs normal-case tracking-normal text-foreground">
      {icon ? <span className="[&_svg]:size-3.5 [&_svg]:text-muted-foreground">{icon}</span> : null}
      <span className="truncate">{value}</span>
    </span>
  );
}
