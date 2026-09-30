import "../../index.css";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { studyBuddyBuiltInProfiles } from "@t3tools/shared/studyBuddyProfiles";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => DEFAULT_SERVER_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: harness.updateSettings }),
}));
vi.mock("~/telemetry/runtime", () => ({ telemetry: { capture: vi.fn() } }));
import { StudyBuddyConnectionPicker, StudyBuddyProfilePicker } from "./StudyBuddyProfilePicker";

function provider(driver: string, models: string[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}
const codex = provider("codex", ["gpt-5.6-terra", "gpt-5.6-sol"]);
const gemini = provider("antigravity", [
  "gemini-flash-low",
  "gemini-flash-medium",
  "gemini-pro-high",
]);

describe("provider profiles (browser-diagnostic)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.updateSettings.mockClear();
  });
  it("hides the connection selector when only Gemini is connected", async () => {
    const screen = await render(
      <StudyBuddyConnectionPicker
        activeProfile={studyBuddyBuiltInProfiles(gemini)[1]!}
        providers={[gemini, { ...codex, auth: { status: "unauthenticated" } }]}
        onCoordinatorChange={vi.fn()}
      />,
    );
    await expect
      .element(page.getByRole("combobox", { name: "AI connection" }))
      .not.toBeInTheDocument();
    await screen.unmount();
  });
  it("switches connected accounts with the corresponding profile rather than a foreign model", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyConnectionPicker
        activeProfile={studyBuddyBuiltInProfiles(codex)[1]!}
        providers={[codex, gemini]}
        onCoordinatorChange={changed}
      />,
    );
    await page.getByRole("combobox", { name: "AI connection" }).click();
    await page.getByRole("option", { name: "Google Gemini", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-flash-medium",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "balanced" }]),
    );
    expect(harness.updateSettings).toHaveBeenCalledWith({
      studyBuddyDefaultProviderInstanceId: "antigravity",
    });
    await screen.unmount();
  });
  it("selects Gemini's Quality plan and shows no model selector", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker
        activeProfile={studyBuddyBuiltInProfiles(gemini)[1]!}
        providers={[codex, gemini]}
        compact={false}
        open
        keybindings={[]}
        terminalOpen={false}
        onCoordinatorChange={changed}
        onOpenChange={vi.fn()}
      />,
    );
    await page.getByRole("option", { name: "Quality", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-pro-high",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "quality" }]),
    );
    expect(document.querySelector("[data-chat-provider-model-picker]")).toBeNull();
    await screen.unmount();
  });
});
