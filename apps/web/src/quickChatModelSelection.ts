import {
  ProviderDriverKind,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveStudyBuddyProfileFromSettings,
  studyBuddyCoordinatorOptions,
} from "@t3tools/shared/studyBuddyProfiles";

function canStartQuickChat(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    provider.models.length > 0
  );
}

export function resolveQuickChatModelSelection(input: {
  settings: ServerSettings;
  providers: ReadonlyArray<ServerProvider>;
}): ModelSelection {
  const profile = resolveStudyBuddyProfileFromSettings(input.settings);
  const coordinator = profile.roles.coordinator;
  const availableProviders = input.providers.filter(canStartQuickChat);
  const provider =
    availableProviders.find((candidate) => candidate.instanceId === coordinator.instanceId) ??
    availableProviders.find((candidate) => candidate.driver === ProviderDriverKind.make("codex")) ??
    availableProviders[0];

  if (!provider) {
    throw new Error(
      "Quick Chat cannot start until an authenticated provider reports an available model.",
    );
  }

  const requestedModel = provider.instanceId === coordinator.instanceId ? coordinator.model : null;
  const model =
    provider.models.find((candidate) => candidate.slug === requestedModel)?.slug ??
    provider.models.find((candidate) => !candidate.isCustom)?.slug ??
    provider.models[0]?.slug;
  if (!model) {
    throw new Error(
      `Quick Chat provider '${provider.instanceId}' did not report an available model.`,
    );
  }

  return createModelSelection(provider.instanceId, model, studyBuddyCoordinatorOptions(profile));
}
