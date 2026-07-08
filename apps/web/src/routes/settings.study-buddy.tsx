import { createFileRoute } from "@tanstack/react-router";

import { StudyBuddySettingsPanel } from "../components/settings/StudyBuddySettings";

export const Route = createFileRoute("/settings/study-buddy")({
  component: StudyBuddySettingsPanel,
});
