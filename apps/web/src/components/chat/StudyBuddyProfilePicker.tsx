import type {
  ProviderInstanceId,
  ProviderOptionSelection,
  ResolvedKeybindingsConfig,
  StudyBuddyExecutionProfileDefinition,
} from "@t3tools/contracts";
import {
  allStudyBuddyProfiles,
  STUDY_BUDDY_BUILT_IN_PROFILES,
  studyBuddyCoordinatorOptions,
} from "@t3tools/shared/studyBuddyProfiles";
import { memo, useCallback, useEffect, useMemo } from "react";

import { useSettings } from "../../hooks/useSettings";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { telemetry } from "../../telemetry/runtime";
import { featureProperties } from "../../telemetry/featureCatalog";
import { StudyBuddyProfileIconView } from "../studyBuddyProfileIcons";
import { Kbd } from "../ui/kbd";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export const StudyBuddyProfilePicker = memo(function StudyBuddyProfilePicker(props: {
  compact: boolean;
  open: boolean;
  activeProfile: StudyBuddyExecutionProfileDefinition;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCoordinatorChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const settings = useSettings();
  const allProfiles = useMemo(
    () => allStudyBuddyProfiles(settings.studyBuddyCustomExecutionProfiles),
    [settings.studyBuddyCustomExecutionProfiles],
  );
  const customProfiles = useMemo(
    () => allProfiles.filter((profile) => profile.kind === "custom"),
    [allProfiles],
  );
  const shortcutContext = useMemo(
    () => ({ terminalFocus: false, terminalOpen: props.terminalOpen, modelPickerOpen: true }),
    [props.terminalOpen],
  );
  const jumpLabelByProfileId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const [index, profile] of allProfiles.entries()) {
      const command = modelPickerJumpCommandForIndex(index);
      if (!command) break;
      const label = shortcutLabelForCommand(props.keybindings, command, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (label) labels.set(profile.id, label);
    }
    return labels;
  }, [allProfiles, props.keybindings, shortcutContext]);

  const selectProfile = useCallback(
    (profileId: string | null) => {
      if (!profileId) return;
      const profile = allProfiles.find((candidate) => candidate.id === profileId);
      if (!profile) return;
      const telemetryProfile = profile.kind === "custom" ? "custom" : profile.id;
      void telemetry.capture({
        event: "execution_profile.selected",
        properties: {
          execution_profile: telemetryProfile,
          profile_kind: profile.kind,
          surface: "composer",
        },
      });
      void telemetry.capture({
        event: "feature.used",
        properties: featureProperties("chat.profile", {
          execution_profile: telemetryProfile,
          profile_kind: profile.kind,
          surface: "composer",
        }),
      });
      const options = studyBuddyCoordinatorOptions(profile);
      props.onCoordinatorChange(
        profile.roles.coordinator.instanceId,
        profile.roles.coordinator.model,
        options,
      );
      props.onOpenChange(false);
    },
    [allProfiles, props.onCoordinatorChange, props.onOpenChange],
  );

  useEffect(() => {
    if (!props.open) return;

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, props.keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        props.onOpenChange(false);
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      const profile = allProfiles[jumpIndex];
      if (!profile) return;
      event.preventDefault();
      event.stopPropagation();
      selectProfile(profile.id);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [
    allProfiles,
    props.keybindings,
    props.onOpenChange,
    props.open,
    selectProfile,
    shortcutContext,
  ]);

  return (
    <Select
      value={props.activeProfile.id}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onValueChange={selectProfile}
    >
      <SelectTrigger
        data-chat-execution-profile-picker="true"
        data-analytics-id="chat.execution-profile-picker"
        variant="ghost"
        size="sm"
        className="w-auto max-w-44 shrink-0 font-medium"
        aria-label="Execution profile"
        title={`${props.activeProfile.name}: ${props.activeProfile.description}`}
      >
        <StudyBuddyProfileIconView icon={props.activeProfile.icon} className="size-4" />
        <SelectValue>
          {props.compact ? props.activeProfile.name : `${props.activeProfile.name} profile`}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup
        side="top"
        alignItemWithTrigger={false}
        matchTriggerWidth={false}
        className="execution-profile-picker-list !max-h-none !overflow-visible"
        popupClassName="min-w-64"
      >
        {customProfiles.length > 0 ? (
          <>
            <SelectGroup>
              <SelectGroupLabel>My profiles</SelectGroupLabel>
              {customProfiles.map((profile) => (
                <ProfileItem
                  key={profile.id}
                  profile={profile}
                  jumpLabel={jumpLabelByProfileId.get(profile.id) ?? null}
                />
              ))}
            </SelectGroup>
            <SelectSeparator />
          </>
        ) : null}
        <SelectGroup>
          <SelectGroupLabel>Built in</SelectGroupLabel>
          {STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => (
            <ProfileItem
              key={profile.id}
              profile={profile}
              jumpLabel={jumpLabelByProfileId.get(profile.id) ?? null}
            />
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

function ProfileItem(props: {
  profile: StudyBuddyExecutionProfileDefinition;
  jumpLabel: string | null;
}) {
  return (
    <SelectItem value={props.profile.id} className="min-w-60">
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <StudyBuddyProfileIconView
            icon={props.profile.icon}
            className="size-3.5 text-muted-foreground"
          />
          <span className="truncate font-medium">{props.profile.name}</span>
        </span>
        {props.jumpLabel ? <Kbd className="shrink-0">{props.jumpLabel}</Kbd> : null}
      </span>
    </SelectItem>
  );
}
