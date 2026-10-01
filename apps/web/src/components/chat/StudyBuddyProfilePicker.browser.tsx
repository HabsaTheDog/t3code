import "../../index.css";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  duplicateStudyBuddyProfile,
  studyBuddyBuiltInProfiles,
} from "@t3tools/shared/studyBuddyProfiles";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  customProfiles: [] as typeof DEFAULT_SERVER_SETTINGS.studyBuddyCustomExecutionProfiles,
}));
vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    studyBuddyCustomExecutionProfiles: harness.customProfiles,
  }),
  useUpdateSettings: () => ({ updateSettings: harness.updateSettings }),
}));
vi.mock("~/telemetry/runtime", () => ({ telemetry: { capture: vi.fn() } }));
import { StudyBuddyProfilePicker } from "./StudyBuddyProfilePicker";

function provider(driver: string, models: string[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}
const codex = provider("codex", ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]);
const gemini = provider("antigravity", [
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-pro-agent",
]);
const claude = provider("claudeAgent", ["claude-haiku", "claude-sonnet", "claude-opus"]);
const balanced = (entry: ServerProvider) =>
  studyBuddyBuiltInProfiles(entry).find((profile) => profile.id === "balanced")!;
const defaults = {
  activeProfile: balanced(codex),
  providers: [codex, gemini],
  compact: false,
  open: true,
  keybindings: [],
  terminalOpen: false,
  onCoordinatorChange: vi.fn(),
  onOpenChange: vi.fn(),
};
const jumpBindings: ResolvedKeybindingsConfig = [
  {
    command: "modelPicker.jump.1",
    shortcut: {
      key: "1",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
    whenAst: { type: "identifier", name: "modelPickerOpen" },
  },
];

async function capturePicker(name: string) {
  const directory = import.meta.env.VITE_PROFILE_REVIEW_DIR;
  if (!directory) return;
  const wasDark = document.documentElement.classList.contains("dark");
  document.documentElement.classList.add("dark");
  try {
    await page
      .getByRole("dialog", { name: "Execution profiles", exact: true })
      .screenshot({ path: `${directory}/${name}.png` });
  } finally {
    if (!wasDark) document.documentElement.classList.remove("dark");
  }
}

describe("provider tabs inside the profile picker (browser-diagnostic)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.updateSettings.mockClear();
    harness.customProfiles = [];
  });

  it("hides tabs with one usable provider and offers the two Gemini presets", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker
        {...defaults}
        activeProfile={balanced(gemini)}
        providers={[gemini, { ...codex, auth: { status: "unauthenticated" } }]}
        onCoordinatorChange={changed}
      />,
    );
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: "Quality", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("option", { name: "Fast", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-3.8-flash-low",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "fast" }]),
    );
    expect(document.querySelector("[data-chat-provider-picker]")).toBeNull();
    await screen.unmount();
  });

  it("browses without changing the coordinator, then selects the provider's own policy", async () => {
    const changed = vi.fn();
    const closed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker {...defaults} onCoordinatorChange={changed} onOpenChange={closed} />,
    );
    await expect
      .element(page.getByRole("tab", { name: "Codex", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
    expect(changed).not.toHaveBeenCalled();
    expect(harness.updateSettings).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("option", { name: "Balanced", exact: true }))
      .toHaveAttribute("aria-selected", "false");
    await page.getByRole("option", { name: "Balanced", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-3.8-flash-medium",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "balanced" }]),
    );
    expect(harness.updateSettings).toHaveBeenCalledWith({
      studyBuddyDefaultProviderInstanceId: "antigravity",
    });
    expect(closed).toHaveBeenCalledWith(false);
    await screen.unmount();
  });

  it("keeps personal and mixed profiles above the tabs across providers", async () => {
    const personal = {
      ...duplicateStudyBuddyProfile(balanced(gemini), "gemini-personal"),
      name: "Gemini personal",
    };
    const mixed = {
      ...duplicateStudyBuddyProfile(balanced(codex), "mixed"),
      name: "Mixed",
      roles: {
        ...balanced(codex).roles,
        artifactBuilder: {
          ...balanced(gemini).roles.artifactBuilder,
          instanceId: gemini.instanceId,
        },
      },
    };
    harness.customProfiles = [personal, mixed];
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker {...defaults} onCoordinatorChange={changed} />,
    );
    await expect
      .element(page.getByRole("option", { name: "Gemini personal", exact: true }))
      .toBeVisible();
    expect(
      page
        .getByRole("listbox", { name: "My profiles", exact: true })
        .element()
        .getBoundingClientRect().bottom,
    ).toBeLessThan(page.getByRole("tablist").element().getBoundingClientRect().top);
    await capturePicker("codex-profile-tabs");
    await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
    await capturePicker("gemini-profile-tabs");
    await page.getByRole("option", { name: "Mixed", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "codex",
      "gpt-6.1-sol",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "mixed" }]),
    );
    expect(harness.customProfiles[1]?.roles.artifactBuilder.instanceId).toBe("antigravity");
    await screen.unmount();
  });

  it("routes a personal profile from another provider without rewriting it", async () => {
    harness.customProfiles = [
      { ...duplicateStudyBuddyProfile(balanced(gemini), "personal"), name: "My Gemini" },
    ];
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker {...defaults} onCoordinatorChange={changed} />,
    );
    await page.getByRole("option", { name: "My Gemini", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-3.8-flash-medium",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "personal" }]),
    );
    await screen.unmount();
  });

  it("honors conversation locks on tabs and profiles, including shortcuts", async () => {
    harness.customProfiles = [
      { ...duplicateStudyBuddyProfile(balanced(gemini), "personal"), name: "My Gemini" },
    ];
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker
        {...defaults}
        lockedInstanceIds={[codex.instanceId]}
        keybindings={jumpBindings}
        onCoordinatorChange={changed}
      />,
    );
    await expect
      .element(page.getByRole("tab", { name: "Google Gemini", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("option", { name: "My Gemini" })).toBeDisabled();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(changed).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("disables mixed profiles with an unavailable worker", async () => {
    const mixed = duplicateStudyBuddyProfile(balanced(codex), "offline-mixed");
    harness.customProfiles = [
      {
        ...mixed,
        name: "Offline mixed",
        roles: {
          ...mixed.roles,
          artifactBuilder: { ...mixed.roles.artifactBuilder, instanceId: gemini.instanceId },
        },
      },
    ];
    const screen = await render(
      <StudyBuddyProfilePicker {...defaults} providers={[codex, { ...gemini, enabled: false }]} />,
    );
    await expect.element(page.getByRole("option", { name: "Offline mixed" })).toBeDisabled();
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("offers Claude's native policies", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker
        {...defaults}
        providers={[codex, gemini, claude]}
        onCoordinatorChange={changed}
      />,
    );
    await page.getByRole("tab", { name: "Claude", exact: true }).click();
    await page.getByRole("option", { name: "Quality", exact: true }).click();
    expect(changed).toHaveBeenCalledWith(
      "claudeAgent",
      "claude-opus",
      expect.arrayContaining([{ id: "effort", value: "high" }]),
    );
    await screen.unmount();
  });

  it("applies jump shortcuts to the visible provider", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker
        {...defaults}
        keybindings={jumpBindings}
        onCoordinatorChange={changed}
      />,
    );
    await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(changed).toHaveBeenCalledWith(
      "antigravity",
      "gemini-3.8-flash-low",
      expect.arrayContaining([{ id: "studyBuddyExecutionProfileId", value: "fast" }]),
    );
    await screen.unmount();
  });

  it("reopens on the active provider and supports option arrows and Escape", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <StudyBuddyProfilePicker {...defaults} open={open} onOpenChange={setOpen} />;
    }
    const screen = await render(<Harness />);
    await page.getByRole("button", { name: "Execution profile", exact: true }).click();
    await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
    page
      .getByRole("tab", { name: "Google Gemini", exact: true })
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect
      .element(page.getByRole("button", { name: "Execution profile", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        page.getByRole("button", { name: "Execution profile", exact: true }).element(),
      ),
    );
    await page.getByRole("button", { name: "Execution profile", exact: true }).click();
    await expect
      .element(page.getByRole("tab", { name: "Codex", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Balanced"));
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement?.textContent).toContain("Quality");
    await screen.unmount();
  });

  it("switches provider tabs with arrow keys without committing a profile", async () => {
    const changed = vi.fn();
    const screen = await render(
      <StudyBuddyProfilePicker {...defaults} onCoordinatorChange={changed} />,
    );
    await page.getByRole("tab", { name: "Codex", exact: true }).click();
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(page.getByRole("tab", { name: "Google Gemini", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    expect(changed).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("keeps a long profile list inside a narrow viewport and scrolls to every built-in", async () => {
    await page.viewport(390, 480);
    harness.customProfiles = Array.from({ length: 12 }, (_, index) => ({
      ...duplicateStudyBuddyProfile(balanced(codex), `personal-${index}`),
      name: `Personal ${index + 1}`,
    }));
    const screen = await render(<StudyBuddyProfilePicker {...defaults} compact />);
    try {
      const dialog = page
        .getByRole("dialog", { name: "Execution profiles", exact: true })
        .element();
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      await page.getByRole("option", { name: "Quality", exact: true }).click();
      await capturePicker("profile-picker-mobile");
    } finally {
      await screen.unmount();
      await page.viewport(1280, 800);
    }
  });
});
