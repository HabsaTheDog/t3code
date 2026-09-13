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
  useServerProviders: () => [
    { driver: "codex", models: [{ slug: "gpt-specialist" }, { slug: "gpt-retry" }] },
  ],
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

const initialSettings = structuredClone(harness.settings);

describe("advanced task assignments (browser-diagnostic)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.updateSettings.mockClear();
    harness.settings = structuredClone(initialSettings);
  });

  it("saves separate primary/fallback settings and resets a task to its role", async () => {
    const mounted = await render(<ExecutionProfilesSettingsPanel />);
    const applySavedSettings = async () => {
      Object.assign(harness.settings, harness.updateSettings.mock.lastCall![0]);
      await mounted.rerender(<ExecutionProfilesSettingsPanel />);
    };
    await page.getByText("Advanced task assignments", { exact: true }).click();
    await page.getByText("Content analyst tasks", { exact: true }).click();
    const task = page.getByRole("group", { name: "Solution generation", exact: true });
    await expect
      .element(task.getByText("Inherited from Content analyst", { exact: true }))
      .toBeVisible();
    await task.getByRole("button", { name: "Override task", exact: true }).click();
    await applySavedSettings();
    await task.getByRole("combobox", { name: "Primary model", exact: true }).click();
    await page.getByRole("option", { name: "gpt-specialist", exact: true }).click();
    await applySavedSettings();
    await task.getByRole("combobox", { name: "Fallback model", exact: true }).click();
    await page.getByRole("option", { name: "gpt-retry", exact: true }).click();
    await applySavedSettings();
    expect(harness.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        studyBuddyCustomExecutionProfiles: [
          expect.objectContaining({
            taskOverrides: {
              solution_generation: expect.objectContaining({
                model: "gpt-specialist",
                retryModel: "gpt-retry",
              }),
            },
          }),
        ],
      }),
    );
    await task.getByRole("button", { name: "Reset to inherited", exact: true }).click();
    await applySavedSettings();
    await expect
      .element(task.getByText("Inherited from Content analyst", { exact: true }))
      .toBeVisible();
    await applySavedSettings();
    expect(harness.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        studyBuddyCustomExecutionProfiles: [expect.objectContaining({ taskOverrides: {} })],
      }),
    );
    await mounted.unmount();
  });

  it("shows built-in search and repair choices read-only at a narrow viewport", async () => {
    await page.viewport(390, 844);
    const mounted = await render(<ExecutionProfilesSettingsPanel />);
    await page.getByRole("button", { name: "Balanced", exact: true }).click();
    await page.getByText("Advanced task assignments", { exact: true }).click();
    await page.getByText("Content analyst tasks", { exact: true }).click();
    const task = page.getByRole("group", { name: "Source search", exact: true });
    await expect.element(task.getByText("gpt-5.6-luna", { exact: true })).toBeVisible();
    await expect
      .element(task.getByRole("button", { name: "Override task" }))
      .not.toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await mounted.unmount();
    await page.viewport(1280, 900);
  });
});
