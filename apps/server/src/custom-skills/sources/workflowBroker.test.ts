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
});
