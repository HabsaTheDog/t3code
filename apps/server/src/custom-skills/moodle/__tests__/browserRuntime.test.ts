import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_RUNTIME_MISSING_CODE,
  resolveSystemBrowserExecutable,
  systemBrowserCandidates,
} from "../browserRuntime.ts";

describe("Study Buddy system browser runtime", () => {
  it("prefers an explicit absolute browser override", async () => {
    const checked: string[] = [];
    await expect(
      resolveSystemBrowserExecutable({
        platform: "win32",
        environment: {
          STUDY_BUDDY_BROWSER_EXECUTABLE: "C:\\Managed\\msedge.exe",
          PROGRAMFILES: "C:\\Program Files",
        },
        pathExists: async (candidate) => {
          checked.push(candidate);
          return candidate === "C:\\Managed\\msedge.exe";
        },
      }),
    ).resolves.toBe("C:\\Managed\\msedge.exe");
    expect(checked).toEqual(["C:\\Managed\\msedge.exe"]);
  });

  it("covers clean Windows Edge/Chrome and Fedora Chromium locations", () => {
    expect(
      systemBrowserCandidates("win32", {
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      }),
    ).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(systemBrowserCandidates("linux", { PATH: "/usr/local/bin:/usr/bin" })).toEqual(
      expect.arrayContaining([
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/local/bin/chromium",
      ]),
    );
  });

  it("fails with a stable typed code instead of assuming a Playwright cache", async () => {
    await expect(
      resolveSystemBrowserExecutable({
        platform: "linux",
        environment: { PATH: "/empty" },
        pathExists: async () => false,
      }),
    ).rejects.toMatchObject({ code: BROWSER_RUNTIME_MISSING_CODE });
  });
});
