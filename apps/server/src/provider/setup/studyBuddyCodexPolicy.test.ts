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
    expect(rendered).toContain("network_proxy = true");
    expect(rendered).toContain("enabled = true");
    expect(rendered).toContain('mode = "limited"');
    expect(rendered).toContain("allow_local_binding = false");
    expect(rendered.match(/"127\.0\.0\.1" = "allow"/g)).toHaveLength(2);
    expect(rendered).not.toContain('"*" = "allow"');
    expect(rendered).toContain('inherit = "core"');
    expect(rendered).toContain('CODEX_HOME = "/state/userdata/codex-home"');
    expect(rendered).toContain('STUDY_BUDDY_CONFIG_ROOT = "/state/userdata"');
    expect(rendered).toContain("default_mode_request_user_input = true");
  });

  it("binds the exact Codex process to the generated home and profile", () => {
    const paths = resolveStudyBuddyCodexPolicyPaths(config);
    expect(
      studyBuddyCodexEnvironment(
        paths,
        {
          PATH: "/bin",
          MOODLE_PASSWORD: "must-not-reach-codex",
          CIS_CALENDAR_URL: "https://calendar.example.test/private",
        },
        "linux",
      ),
    ).toEqual({
      PATH: `${path.join(paths.codexHome, "bin")}${path.delimiter}/bin`,
      CODEX_INSTALL_DIR: path.join(paths.codexHome, "bin"),
      CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_PERMISSION_PROFILE: "study_buddy",
    });
  });

  it("keeps desktop workflow routing in core-only shells without exposing credentials", () => {
    const paths = resolveStudyBuddyCodexPolicyPaths(config);
    const rendered = buildStudyBuddyCodexConfig(paths, {
      STUDY_BUDDY_ROOT: "/workspace/Study Buddy",
      STUDY_BUDDY_T3_ROOT: "/workspace/Study Buddy/t3code-fork",
      STUDY_BUDDY_TASK_WRAPPER: "/workspace/Study Buddy/t3code-fork/scripts/study-buddy-dev-task",
      STUDY_BUDDY_TASK_MODULE:
        "/workspace/Study Buddy/t3code-fork/scripts/study-buddy-packaged-task.mjs",
      STUDY_BUDDY_NODE_EXECUTABLE: "/runtime/electron",
      STUDY_BUDDY_RUNTIME_STATE_ROOT: "/state/desktop-dev",
      MOODLE_USERNAME: "private-user-canary",
      MOODLE_PASSWORD: "private-password-canary",
      CIS_CALENDAR_URL: "https://calendar.example/private-calendar-canary",
      STUDY_BUDDY_SOURCE_LOGIN_SECRET: "private-source-canary",
      STUDY_BUDDY_BROKER_EXECUTION: "1",
      STUDY_BUDDY_WORKSPACE: "/stale/previous-chat",
    });
    const shellSettings = rendered.split("[shell_environment_policy.set]\n")[1]!;
    expect(shellSettings).toContain(
      'STUDY_BUDDY_TASK_WRAPPER = "/workspace/Study Buddy/t3code-fork/scripts/study-buddy-dev-task"',
    );
    expect(shellSettings).toContain('STUDY_BUDDY_NODE_EXECUTABLE = "/runtime/electron"');
    expect(shellSettings).toContain('STUDY_BUDDY_RUNTIME_STATE_ROOT = "/state/desktop-dev"');
    expect(shellSettings).toContain('STUDY_BUDDY_ROOT = "/workspace/Study Buddy"');
    expect(shellSettings).not.toMatch(/MOODLE_|CIS_|SECRET|BROKER_EXECUTION|WORKSPACE|canary/);
    expect(rendered).toContain('inherit = "core"');
    expect(rendered).toContain('"**/.env.*" = "deny"');
  });

  it("uses the current server state for broker discovery when no desktop override exists", () => {
    const rendered = buildStudyBuddyCodexConfig(resolveStudyBuddyCodexPolicyPaths(config), {});
    expect(rendered).toContain('STUDY_BUDDY_RUNTIME_STATE_ROOT = "/state/userdata"');
    expect(rendered).not.toContain("STUDY_BUDDY_TASK_WRAPPER =");
  });

  it("does not alter the Windows installer location or PATH contract", () => {
    const paths = resolveStudyBuddyCodexPolicyPaths(config);
    expect(studyBuddyCodexEnvironment(paths, { PATH: "C:\\Windows" }, "win32")).toEqual({
      PATH: "C:\\Windows",
      CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_HOME: paths.codexHome,
      STUDY_BUDDY_CODEX_PERMISSION_PROFILE: "study_buddy",
    });
  });

  it("escapes Windows paths as valid TOML strings", () => {
    const rendered = buildStudyBuddyCodexConfig({
      codexHome: "C:\\Users\\Student\\AppData\\Local\\StudyBuddy\\Codex",
      configPath: "ignored",
      configRoot: "C:\\Users\\Student\\AppData\\Local\\StudyBuddy\\userdata",
      deniedPaths: ["C:\\Users\\Student\\Study Buddy\\.env.local"],
    });
    expect(rendered).toContain('"C:\\\\Users\\\\Student\\\\Study Buddy\\\\.env.local" = "deny"');
    expect(rendered).toContain(
      'STUDY_BUDDY_CONFIG_ROOT = "C:\\\\Users\\\\Student\\\\AppData\\\\Local\\\\StudyBuddy\\\\userdata"',
    );
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
