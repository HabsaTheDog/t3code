export const FEATURE_CATALOG = [
  { id: "setup.onboarding", area: "Setup", label: "Onboarding and provider setup" },
  { id: "project.management", area: "Projects", label: "Add or switch project" },
  { id: "thread.favorite", area: "Threads", label: "Favorite a thread" },
  { id: "chat.run", area: "Chat", label: "Run an AI request" },
  { id: "chat.stop", area: "Chat", label: "Stop a running response" },
  { id: "chat.model", area: "Chat", label: "Choose a model" },
  { id: "chat.profile", area: "Chat", label: "Choose an execution profile" },
  { id: "chat.runtime_mode", area: "Chat", label: "Choose a runtime mode" },
  { id: "chat.interaction_mode", area: "Chat", label: "Choose an interaction mode" },
  { id: "chat.image_attachment", area: "Chat", label: "Attach an image" },
  { id: "chat.voice", area: "Chat", label: "Use voice input" },
  { id: "chat.terminal_context", area: "Chat", label: "Attach terminal context" },
  { id: "plan.sidebar", area: "Planning", label: "Open the plan sidebar" },
  { id: "orchestration.delegation", area: "Orchestration", label: "Run delegated tasks" },
  { id: "outputs.artifacts", area: "Outputs", label: "Generate a linked artifact" },
  { id: "response.feedback", area: "Feedback", label: "Rate an assistant response" },
  { id: "settings.privacy", area: "Settings", label: "Open privacy settings" },
  { id: "settings.study_buddy", area: "Settings", label: "Configure Study Buddy" },
] as const;

export type FeatureId = (typeof FEATURE_CATALOG)[number]["id"];

const FEATURE_BY_ID = new Map(FEATURE_CATALOG.map((feature) => [feature.id, feature]));

export function featureProperties(
  featureId: FeatureId,
  properties: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const definition = FEATURE_BY_ID.get(featureId)!;
  return {
    feature: definition.id,
    feature_area: definition.area,
    feature_label: definition.label,
    ...properties,
  };
}

export function featuresExposedOnRoute(route: string): ReadonlyArray<FeatureId> {
  if (route === "chat" || route === "home") {
    return [
      "project.management",
      "thread.favorite",
      "chat.run",
      "chat.model",
      "chat.profile",
      "chat.runtime_mode",
      "chat.interaction_mode",
      "chat.image_attachment",
      "chat.voice",
      "chat.terminal_context",
      "plan.sidebar",
    ];
  }
  if (route === "/settings/privacy") return ["settings.privacy"];
  if (route === "/settings/study-buddy") return ["settings.study_buddy"];
  return route === "/pair" ? ["setup.onboarding"] : [];
}

export function commandPaletteFeature(actionValue: string): FeatureId | null {
  if (actionValue === "new-thread" || actionValue === "new-thread-in") return "chat.run";
  if (actionValue === "run-setup") return "setup.onboarding";
  if (actionValue === "add-project" || actionValue.startsWith("add-project:")) {
    return "project.management";
  }
  return null;
}
