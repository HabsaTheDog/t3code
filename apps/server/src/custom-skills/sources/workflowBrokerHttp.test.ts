// @effect-diagnostics nodeBuiltinImport:off -- verifies native process-tree termination contracts.
// @effect-diagnostics globalDate:off -- Permission fixtures require future wall-clock expiry.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createBrokerExecutionRequest,
  applyWorkflowExecutionProfile,
  configuredWorkflowCodexPath,
  safeBaseEnvironment,
  spawnWorkflow,
  stageQuizPermissionRequest,
  terminateWorkflowTree,
} from "./workflowBrokerHttp.ts";
import {
  STUDY_BUDDY_BUILT_IN_PROFILES,
  studyBuddyProfileOverrides,
} from "@t3tools/shared/studyBuddyProfiles";
import {
  captureStudyBuddyQuizApprovalRequest,
  clearStudyBuddyQuizApprovalsForTest,
  resolveStudyBuddyQuizApprovalResponse,
} from "./quizApprovals.ts";

afterEach(clearStudyBuddyQuizApprovalsForTest);

function approveQuiz(request: Record<string, unknown>): void {
  const nativeRequestId = `native-${String(request.requestId)}`;
  captureStudyBuddyQuizApprovalRequest("thread-1", nativeRequestId, [
    {
      id: "study_buddy_quiz_permission_v1",
      header: "Quiz access",
      question: JSON.stringify(request),
      multiSelect: false,
      options: [
        { label: "Work on quiz (Recommended)", description: "Approve this exact quiz." },
        { label: "Do not allow", description: "Do not access the quiz." },
      ],
    },
  ]);
  resolveStudyBuddyQuizApprovalResponse("thread-1", nativeRequestId, {
    study_buddy_quiz_permission_v1: "Work on quiz (Recommended)",
  });
}

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
  it.each(["sources", "document"])(
    "keeps %s model-free without worker-profile arguments",
    (command) => {
      const input = {
        args: [
          command,
          JSON.stringify({
            op: command === "sources" ? "courses" : "prepare",
            ...(command === "document" ? { prompt: "Study request" } : {}),
          }),
        ],
        workspace: path.resolve("/workspace"),
        threadId: "native-owner",
      };
      expect(applyWorkflowExecutionProfile(input, STUDY_BUDDY_BUILT_IN_PROFILES[1]!)).toBe(input);
    },
  );
  it("propagates Balanced instead of an omitted or stale caller profile", () => {
    const profile = STUDY_BUDDY_BUILT_IN_PROFILES.find((entry) => entry.id === "balanced")!;
    const prompt = "Can you please do the mini test for my next math lesson?";
    const result = applyWorkflowExecutionProfile(
      {
        args: [
          "prompt",
          prompt,
          "--language",
          "en",
          "--auto-answer",
          "--execution-profile=quality",
          "--profile-overrides-json",
          "{}",
        ],
        workspace: "/workspace",
        threadId: "owner",
      },
      profile,
    );
    expect(result.args).toEqual([
      "prompt",
      prompt,
      "--language",
      "en",
      "--auto-answer",
      "--execution-profile",
      "balanced",
      "--profile-overrides-json",
      JSON.stringify(studyBuddyProfileOverrides(profile)),
    ]);
    expect(result.threadId).toBe("owner");
  });

  it("keeps custom worker assignments and does not add flags to a runtime probe", () => {
    const profile = {
      ...STUDY_BUDDY_BUILT_IN_PROFILES[0]!,
      id: "my-profile",
      kind: "custom" as const,
      roles: {
        ...STUDY_BUDDY_BUILT_IN_PROFILES[0]!.roles,
        contentAnalyzer: {
          ...STUDY_BUDDY_BUILT_IN_PROFILES[0]!.roles.contentAnalyzer,
          model: "catalog-custom-analyzer",
        },
        quizSolver: {
          ...STUDY_BUDDY_BUILT_IN_PROFILES[0]!.roles.quizSolver,
          model: "catalog-custom-quiz-solver",
        },
      },
    };
    const result = applyWorkflowExecutionProfile(
      {
        args: [
          "doc",
          "Build a guide",
          "--codex-model",
          "stale-coordinator-model",
          "--codex-reasoning-effort=xhigh",
        ],
        workspace: "/workspace",
      },
      profile,
    );
    expect(result.args).toContain("custom");
    expect(result.args).not.toContain("stale-coordinator-model");
    expect(result.args).not.toContain("--codex-model");
    expect(result.args).not.toContain("--codex-reasoning-effort=xhigh");
    expect(JSON.parse(result.args.at(-1)!)).toEqual(studyBuddyProfileOverrides(profile));
    const probe = { args: ["source-runtime-probe"], workspace: "/workspace" };
    expect(applyWorkflowExecutionProfile(probe, profile)).toBe(probe);
  });

  it("uses the configured coordinator CLI instead of choosing a bundled worker runtime", () => {
    expect(configuredWorkflowCodexPath({ binaryPath: "/runtime/codex-current" })).toBe(
      "/runtime/codex-current",
    );
    expect(configuredWorkflowCodexPath({ binaryPath: "" })).toBe("codex");
    expect(configuredWorkflowCodexPath(undefined)).toBe("codex");
  });
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

it.skipIf(process.platform === "win32")(
  "resolves bare Codex through the same managed PATH as the coordinator",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-provider-path-"));
    try {
      const codexHome = path.join(directory, "codex-home");
      const managedBin = path.join(codexHome, "bin");
      const hostBin = path.join(directory, "host-bin");
      await mkdir(managedBin, { recursive: true });
      await mkdir(hostBin);
      for (const [bin, label] of [
        [managedBin, "managed-current"],
        [hostBin, "host-obsolete"],
      ]) {
        const executable = path.join(bin!, "codex");
        await writeFile(executable, `#!/bin/sh\nprintf '${label}\\n'\n`);
        await chmod(executable, 0o700);
      }
      const environment = safeBaseEnvironment(
        { PATH: hostBin, MOODLE_PASSWORD: "canary-secret" },
        codexHome,
        directory,
      );
      const result = await spawnWorkflow({
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write(require("node:child_process").execFileSync("codex", [], { encoding: "utf8" }))',
        ],
        cwd: directory,
        environment,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("managed-current\n");
      expect(environment.CODEX_HOME).toBe(codexHome);
      expect(environment.MOODLE_PASSWORD).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
    approveQuiz(request);

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
    const request = {
      version: 1,
      requestId: "nested/../../../outside",
      owner: "study-buddy",
      action: "execute_quiz_attempt",
      scope: "exact_quiz_attempt",
      status: "pending",
      targetUrl: "https://moodle.example.test/mod/quiz/view.php?id=7",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(requestPath, JSON.stringify(request));
    approveQuiz(request);

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

it("uses only the server-owned Study Buddy source cache root", () => {
  const env = safeBaseEnvironment(
    { STUDY_BUDDY_SOURCE_CACHE_ROOT: "/untrusted", T3CODE_HOME: "/independent-t3" },
    "/study-buddy/codex-home",
    "/study-buddy",
  );
  expect(env.STUDY_BUDDY_SOURCE_CACHE_ROOT).toBe(
    path.join("/study-buddy", "study-buddy-data", "cache", "sources"),
  );
  expect(env.T3CODE_HOME).toBeUndefined();
});
