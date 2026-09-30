import type {
  ProviderInstanceId,
  ProviderOptionSelection,
  ResolvedKeybindingsConfig,
  StudyBuddyExecutionProfileDefinition,
  ServerProvider,
} from "@t3tools/contracts";
import {
  allStudyBuddyProfiles,
  availableStudyBuddyProviders,
  resolveStudyBuddyProfile,
  studyBuddyConnectionLabel,
  unavailableStudyBuddyProfileConnections,
  studyBuddyCoordinatorOptions,
} from "@t3tools/shared/studyBuddyProfiles";
import { memo, useCallback, useEffect, useMemo } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
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
  providers: ReadonlyArray<ServerProvider>;
  lockedInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  onOpenChange: (open: boolean) => void;
  onCoordinatorChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const settings = useSettings();
  const provider = props.providers.find(
    (entry) => entry.instanceId === props.activeProfile.roles.coordinator.instanceId,
  );
  const connected = availableStudyBuddyProviders(props.providers);
  const allProfiles = useMemo(
    () => allStudyBuddyProfiles(settings.studyBuddyCustomExecutionProfiles, provider),
    [settings.studyBuddyCustomExecutionProfiles, provider],
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
      const candidate = allProfiles.find((candidate) => candidate.id === profileId);
      if (!candidate) return;
      const profile = candidate;
      if (
        props.lockedInstanceIds &&
        !props.lockedInstanceIds.includes(profile.roles.coordinator.instanceId)
      )
        return;
      if (unavailableStudyBuddyProfileConnections(profile, props.providers).length > 0) return;
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
      const options = studyBuddyCoordinatorOptions(
        profile,
        props.providers.find((entry) => entry.instanceId === profile.roles.coordinator.instanceId)
          ?.driver,
      );
      props.onCoordinatorChange(
        profile.roles.coordinator.instanceId,
        profile.roles.coordinator.model,
        options,
      );
      props.onOpenChange(false);
    },
    [
      allProfiles,
      props.activeProfile,
      props.onCoordinatorChange,
      props.onOpenChange,
      connected,
      props.providers,
      props.lockedInstanceIds,
    ],
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
                  disabled={
                    Boolean(
                      props.lockedInstanceIds &&
                      !props.lockedInstanceIds.includes(profile.roles.coordinator.instanceId),
                    ) ||
                    unavailableStudyBuddyProfileConnections(profile, props.providers).length > 0
                  }
                  jumpLabel={jumpLabelByProfileId.get(profile.id) ?? null}
                />
              ))}
            </SelectGroup>
            <SelectSeparator />
          </>
        ) : null}
        <SelectGroup>
          <SelectGroupLabel>Built in</SelectGroupLabel>
          {allProfiles
            .filter((profile) => profile.kind === "built-in")
            .map((profile) => (
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
  disabled?: boolean;
}) {
  return (
    <SelectItem
      value={props.profile.id}
      disabled={props.disabled}
      className="min-w-60"
      title={props.profile.description}
    >
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

/** Connections are an account choice; models stay inside execution profiles. */
export function StudyBuddyConnectionPicker(props: {
  activeProfile: StudyBuddyExecutionProfileDefinition;
  providers: ReadonlyArray<ServerProvider>;
  lockedInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  onCoordinatorChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const connected = availableStudyBuddyProviders(props.providers);
  if (connected.length <= 1) return null;
  const select = (id: string | null) => {
    const provider = connected.find((entry) => entry.instanceId === id);
    if (!provider) return;
    const active = props.activeProfile;
    const requested = resolveStudyBuddyProfile({
      activeProfileId:
        settings.studyBuddyProviderProfileIds[provider.instanceId] ??
        (active.kind === "built-in" ? active.id : "balanced"),
      customProfiles: settings.studyBuddyCustomExecutionProfiles,
      provider,
    });
    const profile =
      requested.roles.coordinator.instanceId === provider.instanceId
        ? requested
        : resolveStudyBuddyProfile({ activeProfileId: "balanced", customProfiles: [], provider });
    props.onCoordinatorChange(
      profile.roles.coordinator.instanceId,
      profile.roles.coordinator.model,
      studyBuddyCoordinatorOptions(profile, provider.driver),
    );
    updateSettings({ studyBuddyDefaultProviderInstanceId: provider.instanceId });
  };
  return (
    <Select value={props.activeProfile.roles.coordinator.instanceId} onValueChange={select}>
      <SelectTrigger
        size="sm"
        variant="ghost"
        className="w-auto max-w-44"
        aria-label="AI connection"
        data-chat-provider-picker="true"
      >
        <SelectValue>
          {props.providers.find(
            (provider) => provider.instanceId === props.activeProfile.roles.coordinator.instanceId,
          )
            ? studyBuddyConnectionLabel(
                props.providers.find(
                  (provider) =>
                    provider.instanceId === props.activeProfile.roles.coordinator.instanceId,
                )!,
              )
            : "Choose connection"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup side="top" alignItemWithTrigger={false} matchTriggerWidth={false}>
        {connected.map((provider) => (
          <SelectItem
            key={provider.instanceId}
            value={provider.instanceId}
            disabled={Boolean(
              props.lockedInstanceIds && !props.lockedInstanceIds.includes(provider.instanceId),
            )}
          >
            {studyBuddyConnectionLabel(provider)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
