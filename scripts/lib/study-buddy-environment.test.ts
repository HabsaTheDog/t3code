import { describe, expect, it } from "vite-plus/test";

import {
  mergeMissingLinuxDesktopEnvironment,
  parseLinuxDesktopEnvironment,
  sanitizeStudyBuddyHostEnvironment,
} from "./study-buddy-environment.ts";

describe("sanitizeStudyBuddyHostEnvironment", () => {
  it("keeps application configuration while removing portal credentials", () => {
    expect(
      sanitizeStudyBuddyHostEnvironment({
        PATH: "/bin",
        T3CODE_PORT_OFFSET: "120",
        STUDY_BUDDY_ROOT: "/workspace/study-buddy",
        MOODLE_USERNAME: "student",
        MOODLE_PASSWORD: "portal-secret",
        CIS_CALENDAR_URL: "https://calendar.example.test/private-feed",
        STUDY_BUDDY_SOURCES_JSON: "private-source-catalog",
        STUDY_BUDDY_SOURCE_CALENDAR_4_SECRET: "source-secret",
      }),
    ).toEqual({
      PATH: "/bin",
      T3CODE_PORT_OFFSET: "120",
      STUDY_BUDDY_ROOT: "/workspace/study-buddy",
    });
  });
});

describe("parseLinuxDesktopEnvironment", () => {
  it("keeps only desktop session variables from the user manager", () => {
    expect(
      parseLinuxDesktopEnvironment(
        [
          "DISPLAY=:0",
          "WAYLAND_DISPLAY=wayland-0",
          "XDG_SESSION_TYPE=wayland",
          "XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.test",
          "UNRELATED_SECRET=do-not-copy",
          "DISPLAY_WITHOUT_VALUE=",
        ].join("\n"),
      ),
    ).toEqual({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_SESSION_TYPE: "wayland",
      XAUTHORITY: "/run/user/1000/.mutter-Xwaylandauth.test",
    });
  });
});

describe("mergeMissingLinuxDesktopEnvironment", () => {
  it("fills missing Linux desktop values without replacing caller overrides", () => {
    expect(
      mergeMissingLinuxDesktopEnvironment(
        {
          DISPLAY: ":7",
          WAYLAND_DISPLAY: "",
          PATH: "/bin",
        },
        {
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "wayland-0",
          XDG_SESSION_TYPE: "wayland",
        },
        "linux",
      ),
    ).toEqual({
      DISPLAY: ":7",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_SESSION_TYPE: "wayland",
      PATH: "/bin",
    });
  });

  it("does not import Linux desktop values on another platform", () => {
    expect(mergeMissingLinuxDesktopEnvironment({}, { DISPLAY: ":0" }, "darwin")).toEqual({});
  });
});
