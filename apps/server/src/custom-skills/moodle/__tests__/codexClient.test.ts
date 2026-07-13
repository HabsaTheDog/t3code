import { describe, expect, it } from "vite-plus/test";

import { buildCodexProcessEnvironment } from "../codexClient.ts";

describe("nested Codex credential isolation", () => {
  it("passes only operational environment variables to the model process", () => {
    const environment = buildCodexProcessEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      MOODLE_USERNAME: "student",
      MOODLE_PASSWORD: "moodle-canary",
      CIS_PASSWORD: "cis-canary",
      CIS_CALENDAR_URL: "https://calendar.example/private-token.ics",
      STUDY_BUDDY_ROOT: "/contains/secrets",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/keyring",
    });

    expect(environment).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
    });
    expect(JSON.stringify(environment)).not.toContain("canary");
    expect(environment).not.toHaveProperty("STUDY_BUDDY_ROOT");
    expect(environment).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  });
});
