import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowExtendedChatActions, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("shouldShowExtendedChatActions", () => {
  it("hides project scripts, git actions, and changes for quick chats", () => {
    expect(shouldShowExtendedChatActions("quick-chat")).toBe(false);
  });

  it("keeps the extended actions for regular project chats", () => {
    expect(shouldShowExtendedChatActions("regular")).toBe(true);
    expect(shouldShowExtendedChatActions(undefined)).toBe(true);
  });
});
