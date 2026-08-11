// @effect-diagnostics nodeBuiltinImport:off - validates native cross-platform path rendering.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { ServerConfigShape } from "../../config.ts";
import {
  buildStudyBuddyCodexConfig,
  ensureStudyBuddyCodexHome,
  resolveStudyBuddyCodexPolicyPaths,
  studyBuddyCodexEnvironment,
} from "./studyBuddyCodexPolicy.ts";

const config = {
  cwd: "/workspace/study-buddy",
  stateDir: "/state/userdata",
  secretsDir: "/state/userdata/secrets",
} as ServerConfigShape;

describe("Study Buddy Codex policy", () => {
  it("uses an application-owned Codex home and denies every credential location", () => {
    const paths = resolveStudyBuddyCodexPolicyPaths(config);
    const rendered = buildStudyBuddyCodexConfig(paths);

    expect(paths.codexHome).toBe(path.resolve("/state/userdata/codex-home"));
    expect(rendered).toContain('default_permissions = "study_buddy"');
    expect(rendered).toContain('"/state/userdata/secrets" = "deny"');
    expect(rendered).toContain('"/workspace/study-buddy/.env.local" = "deny"');
    expect(rendered).toContain('"**/.env.*" = "deny"');
    expect(rendered).toContain("enabled = false");
    expect(rendered).toContain('inherit = "core"');
    expect(rendered).toContain("default_mode_request_user_input = true");
  });

  it("binds the exact Codex process to the generated home and profile", () => {
    const paths = resolveStudyBuddyCodexPolicyPaths(config);
    expect(
      studyBuddyCodexEnvironment(paths, {
        PATH: "/bin",
        MOODLE_PASSWORD: "must-not-reach-codex",
        CIS_CALENDAR_URL: "https://calendar.example.test/private",
      }),
    ).toEqual({
      PATH: "/bin",
      CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_PERMISSION_PROFILE: "study_buddy",
    });
  });

  it("escapes Windows paths as valid TOML strings", () => {
    const rendered = buildStudyBuddyCodexConfig({
      codexHome: "C:\\Users\\Student\\AppData\\Local\\StudyBuddy\\Codex",
      configPath: "ignored",
      deniedPaths: ["C:\\Users\\Student\\Study Buddy\\.env.local"],
    });
    expect(rendered).toContain('"C:\\\\Users\\\\Student\\\\Study Buddy\\\\.env.local" = "deny"');
  });

  it("materializes a private app-owned home with an atomic generated config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "study-buddy-codex-policy-"));
    try {
      const paths = await ensureStudyBuddyCodexHome({
        ...config,
        stateDir,
        secretsDir: path.join(stateDir, "secrets"),
      });
      expect(await readFile(paths.configPath, "utf8")).toContain(
        'default_permissions = "study_buddy"',
      );
      if (process.platform !== "win32") {
        expect((await stat(paths.codexHome)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
