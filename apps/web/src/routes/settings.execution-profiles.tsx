import { createFileRoute } from "@tanstack/react-router";
import { ExecutionProfilesSettingsPanel } from "../components/settings/ExecutionProfilesSettings";

export const Route = createFileRoute("/settings/execution-profiles")({
  component: ExecutionProfilesSettingsPanel,
});
