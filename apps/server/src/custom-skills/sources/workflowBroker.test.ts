// @effect-diagnostics nodeBuiltinImport:off -- Native path fixtures validate cross-platform argv.
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { executeStudyBuddyWorkflow, type StudyBuddyWorkflowInvocation } from "./workflowBroker.ts";

describe("Study Buddy workflow broker", () => {
  it("injects source credentials only at the server-owned child-process boundary", async () => {
    const username = "broker-user-canary";
    const password = "broker-password-canary";
    let invocation: StudyBuddyWorkflowInvocation | undefined;
    const spawnWorkflow = vi.fn(async (input: StudyBuddyWorkflowInvocation) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: "/workspace/study-buddy-data/runs/test-run\n",
        stderr: `login failed for ${username} with ${password}`,
      };
    });

    const result = await executeStudyBuddyWorkflow(
      {
        args: ["interactive-study-guide", "Build a deterministic test guide"],
        workspace: path.resolve("/workspace"),
        threadId: "thread-1",
      },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/Study Buddy (Alpha).exe"),
        baseEnvironment: {
          PATH: "/usr/bin",
          STUDY_BUDDY_CONFIG_ROOT: "/private/state",
        },
        resolveWorkflowEnvironment: async () => ({
          MOODLE_USERNAME: username,
          MOODLE_PASSWORD: password,
          MOODLE_DASHBOARD_URL: "https://moodle.example.edu/my/",
        }),
        spawnWorkflow,
      },
    );

    expect(spawnWorkflow).toHaveBeenCalledTimes(1);
    expect(invocation).toBeDefined();
    if (!invocation) throw new Error("Workflow invocation was not captured.");
    expect(invocation.command).toBe(path.resolve("/application/Study Buddy (Alpha).exe"));
    expect(invocation.args).toEqual([
      path.resolve("/application/resources/study-buddy-runtime/bin/study_buddy_task.mjs"),
      "interactive-study-guide",
      "Build a deterministic test guide",
    ]);
    expect(invocation.cwd).toBe(path.resolve("/workspace"));
    expect(invocation.environment).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      STUDY_BUDDY_BROKER_EXECUTION: "1",
      STUDY_BUDDY_ROOT: path.resolve("/application/resources/study-buddy-runtime"),
      STUDY_BUDDY_WORKSPACE: path.resolve("/workspace"),
      STUDY_BUDDY_THREAD_ID: "thread-1",
      MOODLE_USERNAME: username,
      MOODLE_PASSWORD: password,
    });
    expect(JSON.stringify(result)).not.toContain(username);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "/workspace/study-buddy-data/runs/test-run\n",
      stderr: "login failed for [REDACTED] with [REDACTED]",
    });
  });

  it("rejects commands outside the packaged workflow allowlist before resolving secrets", async () => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({ MOODLE_PASSWORD: "not-used" }));
    const spawnWorkflow = vi.fn();

    await expect(
      executeStudyBuddyWorkflow(
        { args: ["arbitrary-command"], workspace: path.resolve("/workspace") },
        {
          packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
          nodeExecutable: path.resolve("/application/study-buddy-t3code"),
          baseEnvironment: {},
          resolveWorkflowEnvironment,
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow("Unsupported Study Buddy workflow command");
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it("rejects resume paths outside the registered workspace before resolving secrets", async () => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({ MOODLE_PASSWORD: "not-used" }));
    const spawnWorkflow = vi.fn();

    await expect(
      executeStudyBuddyWorkflow(
        {
          args: ["interactive-study-guide-resume", "continue", process.cwd()],
          workspace: path.resolve("/registered-workspace"),
        },
        {
          packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
          nodeExecutable: path.resolve("/application/study-buddy-t3code"),
          baseEnvironment: {},
          resolveWorkflowEnvironment,
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow("must stay inside the active workspace");
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it("redacts even one-character credentials from workflow output", async () => {
    const result = await executeStudyBuddyWorkflow(
      { args: ["diagnose", "test"], workspace: path.resolve("/workspace") },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => ({
          MOODLE_USERNAME: "u",
          MOODLE_PASSWORD: "p",
        }),
        spawnWorkflow: async () => ({
          exitCode: 1,
          stdout: "username=u password=p",
          stderr: "credentials u/p rejected",
        }),
      },
    );

    expect(result.stdout).toBe("[REDACTED]sername=[REDACTED] [REDACTED]assword=[REDACTED]");
    expect(result.stderr).toBe("credentials [REDACTED]/[REDACTED] rejected");
    expect(JSON.stringify(result)).not.toContain('"u"');
    expect(JSON.stringify(result)).not.toContain('"p"');
  });

  it("redacts longer overlapping credentials before their substrings", async () => {
    const result = await executeStudyBuddyWorkflow(
      { args: ["diagnose", "test"], workspace: path.resolve("/workspace") },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => ({
          MOODLE_USERNAME: "alice",
          MOODLE_PASSWORD: "alice123",
        }),
        spawnWorkflow: async () => ({ exitCode: 1, stdout: "alice123", stderr: "" }),
      },
    );

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("123");
  });

  it("accepts legacy stable source IDs and redacts private calendar URLs", async () => {
    const calendarUrl = "https://calendar.example.edu/private/token";
    const resolveWorkflowEnvironment = vi.fn(async () => ({ CIS_CALENDAR_URL: calendarUrl }));
    const result = await executeStudyBuddyWorkflow(
      {
        args: ["combined", "tomorrow"],
        workspace: path.resolve("/workspace"),
        sourceIds: ["legacy-calendar"],
      },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment,
        spawnWorkflow: async () => ({
          exitCode: 1,
          stdout: `calendar=${calendarUrl}`,
          stderr: "",
        }),
      },
    );

    expect(resolveWorkflowEnvironment).toHaveBeenCalledWith({
      args: ["combined", "tomorrow"],
      sourceIds: ["legacy-calendar"],
    });
    expect(result.stdout).toBe("calendar=[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(calendarUrl);
  });
});
