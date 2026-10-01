import type {
  ProviderInstanceId,
  ProviderOptionSelection,
  ResolvedKeybindingsConfig,
  StudyBuddyExecutionProfileDefinition,
  ServerProvider,
} from "@t3tools/contracts";
import {
  studyBuddyBuiltInProfiles,
  availableStudyBuddyProviders,
  studyBuddyConnectionLabel,
  unavailableStudyBuddyProfileConnections,
  studyBuddyCoordinatorOptions,
} from "@t3tools/shared/studyBuddyProfiles";
import { Tabs } from "@base-ui/react/tabs";
import { CheckIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

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
import { SelectButton } from "../ui/select";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";

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
  const { updateSettings } = useUpdateSettings();
  const activeInstanceId = props.activeProfile.roles.coordinator.instanceId;
  const [browsedInstanceId, setBrowsedInstanceId] = useState(activeInstanceId);
  const popupRef = useRef<HTMLDivElement>(null);
  const connected = useMemo(() => availableStudyBuddyProviders(props.providers), [props.providers]);
  const provider =
    connected.find((entry) => entry.instanceId === browsedInstanceId) ??
    connected.find((entry) => entry.instanceId === activeInstanceId) ??
    connected[0] ??
    props.providers.find((entry) => entry.instanceId === activeInstanceId);
  const builtInProfiles = useMemo(() => {
    if (!provider) return [];
    return studyBuddyBuiltInProfiles(provider);
  }, [provider]);
  const customProfiles = settings.studyBuddyCustomExecutionProfiles;
  const allProfiles = useMemo(
    () => [...customProfiles, ...builtInProfiles],
    [customProfiles, builtInProfiles],
  );
  const isDisabled = useCallback(
    (profile: StudyBuddyExecutionProfileDefinition) =>
      Boolean(
        props.lockedInstanceIds &&
        !props.lockedInstanceIds.includes(profile.roles.coordinator.instanceId),
      ) || unavailableStudyBuddyProfileConnections(profile, props.providers).length > 0,
    [props.lockedInstanceIds, props.providers],
  );
  const isSelected = (profile: StudyBuddyExecutionProfileDefinition) =>
    profile.id === props.activeProfile.id &&
    profile.roles.coordinator.instanceId === activeInstanceId;

  useEffect(() => {
    // Each opening starts on the active connection, including programmatic /model opens.
    setBrowsedInstanceId(activeInstanceId);
  }, [props.open, activeInstanceId]);
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
      if (isDisabled(profile)) return;
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
      if (profile.roles.coordinator.instanceId !== activeInstanceId) {
        updateSettings({
          studyBuddyDefaultProviderInstanceId: profile.roles.coordinator.instanceId,
        });
      }
      props.onOpenChange(false);
    },
    [
      allProfiles,
      props.onCoordinatorChange,
      props.onOpenChange,
      props.providers,
      isDisabled,
      activeInstanceId,
      updateSettings,
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

  const renderProfiles = (
    profiles: ReadonlyArray<StudyBuddyExecutionProfileDefinition>,
    label: string,
  ) => (
    <div role="listbox" aria-label={label} onKeyDown={navigateProfiles}>
      {profiles.map((profile) => (
        <ProfileItem
          key={profile.id}
          profile={profile}
          selected={isSelected(profile)}
          disabled={isDisabled(profile)}
          jumpLabel={jumpLabelByProfileId.get(profile.id) ?? null}
          onSelect={() => selectProfile(profile.id)}
        />
      ))}
    </div>
  );
  const providerLocked = Boolean(
    provider && props.lockedInstanceIds && !props.lockedInstanceIds.includes(provider.instanceId),
  );
  const builtIns = (
    <>
      {providerLocked && provider ? (
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          Start a new chat to use {studyBuddyConnectionLabel(provider)} profiles.
        </p>
      ) : null}
      {renderProfiles(builtInProfiles, "Built-in profiles")}
    </>
  );

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        render={
          <SelectButton
            data-chat-execution-profile-picker="true"
            data-analytics-id="chat.execution-profile-picker"
            variant="ghost"
            size="sm"
            className="w-auto max-w-44 shrink-0 font-medium"
            aria-label="Execution profile"
            title={`${props.activeProfile.name}: ${props.activeProfile.description}`}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <StudyBuddyProfileIconView icon={props.activeProfile.icon} className="size-4 shrink-0" />
          <span className="truncate">
            {props.compact ? props.activeProfile.name : `${props.activeProfile.name} profile`}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        ref={popupRef}
        side="top"
        align="start"
        aria-label="Execution profiles"
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>(
            '[role="option"][aria-selected="true"]:not(:disabled)',
          ) ??
          popupRef.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled)') ??
          popupRef.current
        }
        className="execution-profile-picker-list w-68 max-w-[calc(100vw-1rem)] [--viewport-inline-padding:--spacing(1)] *:data-[slot=popover-viewport]:py-1"
      >
        {customProfiles.length > 0 ? (
          <>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">My profiles</div>
            {renderProfiles(customProfiles, "My profiles")}
            <div className="mx-2 my-1 h-px bg-border" />
          </>
        ) : null}
        {connected.length > 1 && provider ? (
          <Tabs.Root
            value={provider.instanceId}
            onValueChange={(value) => setBrowsedInstanceId(value as ProviderInstanceId)}
          >
            <div className="flex items-center justify-between gap-2 px-2">
              <span className="py-1.5 text-xs font-medium text-muted-foreground">Built in</span>
              <Tabs.List
                aria-label="Built-in profile providers"
                activateOnFocus
                className="flex shrink-0 gap-1"
              >
                {connected.map((entry) => {
                  const label = studyBuddyConnectionLabel(entry);
                  return (
                    <Tooltip key={entry.instanceId}>
                      <TooltipTrigger
                        render={
                          <Tabs.Tab
                            value={entry.instanceId}
                            aria-label={label}
                            title={label}
                            className="flex size-8 cursor-pointer items-center justify-center rounded-t-sm border-b-2 border-transparent text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-active:border-primary data-active:text-foreground"
                          />
                        }
                      >
                        <ProviderInstanceIcon
                          driverKind={entry.driver}
                          displayName={label}
                          showBadge={
                            connected.filter((candidate) => candidate.driver === entry.driver)
                              .length > 1
                          }
                          iconClassName="size-4"
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{label}</TooltipPopup>
                    </Tooltip>
                  );
                })}
              </Tabs.List>
            </div>
            <Tabs.Panel value={provider.instanceId}>{builtIns}</Tabs.Panel>
          </Tabs.Root>
        ) : (
          <>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Built in</div>
            {builtIns}
          </>
        )}
        {builtInProfiles.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Connect an AI provider in Settings to use built-in profiles.
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});

function navigateProfiles(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
  );
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || options.length === 0) return;
  const next =
    event.key === "ArrowDown"
      ? (index + 1) % options.length
      : event.key === "ArrowUp"
        ? (index - 1 + options.length) % options.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  options[next]?.focus();
}

function ProfileItem(props: {
  profile: StudyBuddyExecutionProfileDefinition;
  jumpLabel: string | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "grid min-h-8 w-full grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-3 text-left text-base outline-none hover:bg-accent focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:min-h-7 sm:text-sm",
      )}
      title={props.profile.description}
    >
      <span>{props.selected ? <CheckIcon className="size-3.5" /> : null}</span>
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
    </button>
  );
}
