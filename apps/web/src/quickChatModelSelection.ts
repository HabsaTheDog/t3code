import { type ModelSelection, type ServerProvider, type ServerSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  availableStudyBuddyProviders,
  resolveStudyBuddyProfile,
  studyBuddyCoordinatorOptions,
  unavailableStudyBuddyProfileConnections,
} from "@t3tools/shared/studyBuddyProfiles";

export function resolveQuickChatModelSelection(input: {
  settings: ServerSettings;
  providers: ReadonlyArray<ServerProvider>;
}): ModelSelection {
  const availableProviders = availableStudyBuddyProviders(input.providers);
  const provider =
    availableProviders.find(
      (candidate) => candidate.instanceId === input.settings.studyBuddyDefaultProviderInstanceId,
    ) ?? availableProviders[0];
  if (!provider)
    throw new Error(
      "Quick Chat cannot start until an authenticated provider reports an available model.",
    );
  const id =
    input.settings.studyBuddyProviderProfileIds[provider.instanceId] ??
    input.settings.studyBuddyExecutionProfileId;
  const requested = resolveStudyBuddyProfile({
    activeProfileId: id,
    ...(!input.settings.studyBuddyProviderProfileIds[provider.instanceId]
      ? { legacyProfile: input.settings.studyBuddyExecutionProfile }
      : {}),
    customProfiles: input.settings.studyBuddyCustomExecutionProfiles,
    provider,
  });
  // A legacy global mixed profile must not override the chosen default connection.
  const profile =
    requested.roles.coordinator.instanceId === provider.instanceId
      ? requested
      : resolveStudyBuddyProfile({ activeProfileId: "balanced", customProfiles: [], provider });
  const unavailable = unavailableStudyBuddyProfileConnections(profile, input.providers);
  if (unavailable.length > 0)
    throw new Error(
      `This profile needs disconnected connections: ${unavailable.join(", ")}. Connect them in Settings or choose another profile.`,
    );
  const coordinatorProvider = availableProviders.find(
    (candidate) => candidate.instanceId === profile.roles.coordinator.instanceId,
  );
  if (!coordinatorProvider)
    throw new Error(
      "This profile's coordinator connection is unavailable. Choose another profile or connect it in Settings.",
    );
  const model =
    coordinatorProvider.models.find(
      (candidate) => candidate.slug === profile.roles.coordinator.model,
    )?.slug ??
    coordinatorProvider.models.find((candidate) => !candidate.isCustom)?.slug ??
    coordinatorProvider.models[0]?.slug;
  if (!model)
    throw new Error(
      `Quick Chat provider '${coordinatorProvider.instanceId}' did not report an available model.`,
    );
  return createModelSelection(
    coordinatorProvider.instanceId,
    model,
    studyBuddyCoordinatorOptions(profile, coordinatorProvider.driver),
  );
}
