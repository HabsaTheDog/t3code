// @effect-diagnostics nodeBuiltinImport:off -- verifies native process-tree termination contracts.
// @effect-diagnostics globalDate:off -- Permission fixtures require future wall-clock expiry.
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createBrokerExecutionRequest,
  spawnWorkflow,
  stageQuizPermissionRequest,
  terminateWorkflowTree,
} from "./workflowBrokerHttp.ts";

describe("Study Buddy workflow broker process termination", () => {
  it("uses taskkill tree termination on Windows", () => {
    const kill = vi.fn(() => true);
    const spawnSyncProcess = vi.fn(() => ({ status: 0 }));

    terminateWorkflowTree({ pid: 321, kill }, "win32", spawnSyncProcess);

    expect(spawnSyncProcess).toHaveBeenCalledWith("taskkill.exe", ["/PID", "321", "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the wrapper when Windows tree termination fails", () => {
    const kill = vi.fn(() => true);
    const spawnSyncProcess = vi.fn(() => ({ status: 1 }));

    terminateWorkflowTree({ pid: 654, kill }, "win32", spawnSyncProcess);

    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("terminates the detached process group on Unix-like systems", () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const killProcess = vi.fn(() => true) as unknown as typeof process.kill;

    const cancelEscalation = terminateWorkflowTree(
      { pid: 777, kill },
      "linux",
      undefined,
      killProcess,
    );

    expect(killProcess).toHaveBeenCalledWith(-777, "SIGTERM");
    vi.advanceTimersByTime(2_000);
    expect(killProcess).toHaveBeenCalledWith(-777, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
    cancelEscalation?.();
    vi.useRealTimers();
  });

  it("terminates a running workflow when its broker request is aborted", async () => {
    const controller = new AbortController();
    const result = spawnWorkflow(
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        cwd: process.cwd(),
        environment: process.env,
      },
      controller.signal,
    );

    controller.abort();

    await expect(result).resolves.toMatchObject({ exitCode: 1 });
  });
});

describe("Study Buddy workflow broker request identity", () => {
  it("replaces caller-controlled thread ids with a server-owned execution scope", () => {
    expect(
      createBrokerExecutionRequest(
        {
          args: ["doc", "Build a guide"],
          workspace: "/caller/workspace",
          threadId: "another-users-thread",
        },
        "/canonical/workspace",
        () => "00000000-0000-4000-8000-000000000001",
      ),
    ).toMatchObject({
      workspace: "/canonical/workspace",
      threadId: "broker-00000000-0000-4000-8000-000000000001",
    });
  });
});

describe("Study Buddy quiz permission staging", () => {
  it("copies a valid workspace request into private server state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-workspace-"));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-state-"));
    const requestPath = path.join(workspace, "quiz-permission-request.json");
    const request = {
      version: 1,
      requestId: "request-1",
      owner: "study-buddy",
      action: "execute_quiz_attempt",
      scope: "exact_quiz_attempt",
      status: "pending",
      targetUrl: "https://moodle.example.test/mod/quiz/view.php?id=7",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(requestPath, JSON.stringify(request));

    try {
      const stagedPath = await stageQuizPermissionRequest({
        requestPath,
        workspace,
        stateDir,
        workflowEnvironment: {
          STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
        },
      });

      expect(path.relative(path.join(stateDir, "workflow-approvals"), stagedPath)).not.toMatch(
        /^\.\./,
      );
      expect(JSON.parse(await readFile(stagedPath, "utf8"))).toMatchObject(request);
      if (process.platform !== "win32") expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink outside the workspace and an unselected target origin", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-workspace-"));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-state-"));
    const outside = path.join(stateDir, "outside.json");
    const linked = path.join(workspace, "linked.json");
    const request = {
      version: 1,
      requestId: "request-2",
      owner: "study-buddy",
      action: "execute_quiz_attempt",
      scope: "exact_quiz_attempt",
      status: "pending",
      targetUrl: "https://attacker.example.test/quiz",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(outside, JSON.stringify(request));
    await symlink(outside, linked);

    try {
      await expect(
        stageQuizPermissionRequest({
          requestPath: linked,
          workspace,
          stateDir,
          workflowEnvironment: {
            STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
          },
        }),
      ).rejects.toThrow("must originate in the active workspace");

      await writeFile(path.join(workspace, "direct.json"), JSON.stringify(request));
      await expect(
        stageQuizPermissionRequest({
          requestPath: path.join(workspace, "direct.json"),
          workspace,
          stateDir,
          workflowEnvironment: {
            STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
          },
        }),
      ).rejects.toThrow("outside the selected Moodle source");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps request ids with path separators inside private server state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-workspace-"));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "study-buddy-quiz-state-"));
    const requestPath = path.join(workspace, "quiz-permission-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        version: 1,
        requestId: "nested/../../../outside",
        owner: "study-buddy",
        action: "execute_quiz_attempt",
        scope: "exact_quiz_attempt",
        status: "pending",
        targetUrl: "https://moodle.example.test/mod/quiz/view.php?id=7",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    try {
      const stagedPath = await stageQuizPermissionRequest({
        requestPath,
        workspace,
        stateDir,
        workflowEnvironment: {
          STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
        },
      });

      const stagingRoot = path.join(stateDir, "workflow-approvals");
      expect(path.dirname(stagedPath)).toBe(stagingRoot);
      expect(path.basename(stagedPath)).toMatch(/^quiz-[0-9a-f-]+\.json$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
