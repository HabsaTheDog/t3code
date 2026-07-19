import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const worker = {
    model: "gpt-5.6-luna",
    reasoningEffort: "low" as const,
    retryModel: "gpt-5.6-terra",
    retryReasoningEffort: "medium" as const,
  };

  return {
    settings: {
      studyBuddyExecutionProfile: "custom" as const,
      studyBuddyExecutionProfileId: "custom-fast-copy",
      studyBuddyCustomExecutionProfiles: [
        {
          id: "custom-fast-copy",
          name: "Fast copy",
          description: "A custom execution profile used to check the editor controls.",
          kind: "custom" as const,
          icon: "zap" as const,
          roles: {
            coordinator: {
              instanceId: "codex",
              model: "gpt-5.6-luna",
              reasoningEffort: "low" as const,
            },
            contentAnalyzer: { ...worker },
            quizSolver: { ...worker },
            artifactPlanner: { ...worker },
            artifactBuilder: { ...worker },
            qualityReviewer: { ...worker },
          },
        },
      ],
    },
    updateSettings: vi.fn(),
  };
});

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => harness.settings,
  useUpdateSettings: () => ({ updateSettings: harness.updateSettings }),
}));

vi.mock("~/rpc/serverState", () => ({
  useServerProviders: () => [],
}));

import { ExecutionProfilesSettingsPanel } from "./ExecutionProfilesSettings";

describe("execution profile settings", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.updateSettings.mockClear();
  });

  it("keeps the custom profile icon and dropdown arrow inside the selector", async () => {
    const mounted = await render(<ExecutionProfilesSettingsPanel />);

    await expect.element(page.getByRole("combobox", { name: "Profile icon" })).toBeVisible();

    await vi.waitFor(() => {
      const trigger = document.querySelector<HTMLElement>('[aria-label="Profile icon"]');
      const chevron = trigger?.querySelector<SVGElement>('[data-slot="select-icon"] svg');

      expect(trigger).toBeTruthy();
      expect(chevron).toBeTruthy();

      const triggerRect = trigger!.getBoundingClientRect();
      const chevronRect = chevron!.getBoundingClientRect();

      expect(triggerRect.width).toBeGreaterThanOrEqual(48);
      expect(chevronRect.left).toBeGreaterThanOrEqual(triggerRect.left);
      expect(chevronRect.right).toBeLessThanOrEqual(triggerRect.right);
    });

    await mounted.unmount();
  });
});
