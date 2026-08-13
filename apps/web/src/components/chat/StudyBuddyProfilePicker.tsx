import type {
  ProviderInstanceId,
  ProviderOptionSelection,
  StudyBuddyExecutionProfileDefinition,
} from "@t3tools/contracts";
import {
  allStudyBuddyProfiles,
  STUDY_BUDDY_BUILT_IN_PROFILES,
  studyBuddyCoordinatorOptions,
} from "@t3tools/shared/studyBuddyProfiles";
import { memo } from "react";

import { useSettings } from "../../hooks/useSettings";
import { telemetry } from "../../telemetry/runtime";
import { featureProperties } from "../../telemetry/featureCatalog";
import { StudyBuddyProfileIconView } from "../studyBuddyProfileIcons";
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
  onOpenChange: (open: boolean) => void;
  onCoordinatorChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const settings = useSettings();
  const allProfiles = allStudyBuddyProfiles(settings.studyBuddyCustomExecutionProfiles);
  const customProfiles = allProfiles.filter((profile) => profile.kind === "custom");

  const selectProfile = (profileId: string | null) => {
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
  };

  return (
    <Select
      value={props.activeProfile.id}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onValueChange={selectProfile}
    >
      <SelectTrigger
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
        className="!max-h-none !overflow-visible"
        popupClassName="min-w-64"
      >
        {customProfiles.length > 0 ? (
          <>
            <SelectGroup>
              <SelectGroupLabel>My profiles</SelectGroupLabel>
              {customProfiles.map((profile) => (
                <ProfileItem key={profile.id} profile={profile} />
              ))}
            </SelectGroup>
            <SelectSeparator />
          </>
        ) : null}
        <SelectGroup>
          <SelectGroupLabel>Built in</SelectGroupLabel>
          {STUDY_BUDDY_BUILT_IN_PROFILES.map((profile) => (
            <ProfileItem key={profile.id} profile={profile} />
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

function ProfileItem(props: { profile: StudyBuddyExecutionProfileDefinition }) {
  return (
    <SelectItem value={props.profile.id} className="min-w-60">
      <span className="flex min-w-0 items-center gap-2">
        <StudyBuddyProfileIconView
          icon={props.profile.icon}
          className="size-3.5 text-muted-foreground"
        />
        <span className="truncate font-medium">{props.profile.name}</span>
      </span>
    </SelectItem>
  );
}
