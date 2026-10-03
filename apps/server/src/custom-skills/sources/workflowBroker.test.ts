// @effect-diagnostics nodeBuiltinImport:off -- Native path fixtures validate cross-platform argv.
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vite-plus/test";

import { executeStudyBuddyWorkflow, type StudyBuddyWorkflowInvocation } from "./workflowBroker.ts";
import { spawnWorkflow as spawnNativeWorkflow } from "./workflowBrokerHttp.ts";

describe("Study Buddy workflow broker", () => {
  it("stages direct quiz approval through the native grant boundary and forwards only trusted proof", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "direct-quiz-broker-"));
    try {
      const staged = path.join(directory, "server-approved.json");
      await writeFile(staged, JSON.stringify({ requestId: "native-approved-id" }));
      const stageQuizPermissionRequest = vi.fn(async () => staged);
      let invocation: StudyBuddyWorkflowInvocation | undefined;
      await executeStudyBuddyWorkflow(
        {
          args: [
            "quiz",
            JSON.stringify({
              op: "start",
              runDir: "/workspace/run",
              permissionRequestPath: "/workspace/pending.json",
            }),
          ],
          workspace: path.resolve("/workspace"),
          threadId: "owner",
        },
        {
          packagedRoot: "/app",
          nodeExecutable: process.execPath,
          baseEnvironment: {
            STUDY_BUDDY_QUIZ_ATTEMPT_LEDGER_ROOT: "/private/ledger",
            STUDY_BUDDY_QUIZ_APPROVED_REQUEST_IDS: '["forged"]',
          },
          resolveWorkflowEnvironment: async () => ({}),
          stageQuizPermissionRequest,
          spawnWorkflow: async (input) => {
            invocation = input;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(stageQuizPermissionRequest).toHaveBeenCalledWith({
        requestPath: "/workspace/pending.json",
        workspace: path.resolve("/workspace"),
        workflowEnvironment: {},
      });
      expect(JSON.parse(invocation!.args[2]!)).toMatchObject({ permissionRequestPath: staged });
      expect(invocation!.environment.STUDY_BUDDY_QUIZ_APPROVED_REQUEST_IDS).toBe(
        '["native-approved-id"]',
      );
      expect(invocation!.environment.STUDY_BUDDY_QUIZ_ATTEMPT_LEDGER_ROOT).toBe("/private/ledger");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { op: "submit", runDir: "/workspace/run" },
    { op: "start", runDir: "/workspace/run", attemptId: "second" },
    { op: "read", runDir: "/workspace/run", model: "override" },
    {
      op: "inspect",
      url: "https://moodle.example/mod/quiz/view.php?id=1",
      ledgerRoot: "/override",
    },
  ])("rejects direct quiz control overrides before resolving credentials: $op", async (payload) => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({}));
    const spawnWorkflow = vi.fn();
    await expect(
      executeStudyBuddyWorkflow(
        {
          args: ["quiz", JSON.stringify(payload)],
          workspace: path.resolve("/workspace"),
          threadId: "owner",
        },
        {
          packagedRoot: "/app",
          nodeExecutable: process.execPath,
          baseEnvironment: {},
          resolveWorkflowEnvironment,
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow();
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it("requires a native owner and refuses unstaged direct quiz approvals", async () => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({}));
    const spawnWorkflow = vi.fn();
    const dependencies = {
      packagedRoot: "/app",
      nodeExecutable: process.execPath,
      baseEnvironment: {},
      resolveWorkflowEnvironment,
      spawnWorkflow,
    };
    await expect(
      executeStudyBuddyWorkflow(
        {
          args: [
            "quiz",
            JSON.stringify({ op: "inspect", url: "https://moodle.example/mod/quiz/view.php?id=1" }),
          ],
          workspace: path.resolve("/workspace"),
        },
        dependencies,
      ),
    ).rejects.toThrow("owning native thread");
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    await expect(
      executeStudyBuddyWorkflow(
        {
          args: [
            "quiz",
            JSON.stringify({
              op: "start",
              runDir: "/workspace/run",
              permissionRequestPath: "/workspace/pending.json",
            }),
          ],
          workspace: path.resolve("/workspace"),
          threadId: "owner",
        },
        dependencies,
      ),
    ).rejects.toThrow("staging");
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });
  it.each(["interactive-study-guide", "source-evidence"])(
    "injects source credentials only at the server-owned child-process boundary for %s",
    async (command) => {
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
          args: [command, "Build a deterministic test guide"],
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
        command,
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
    },
  );

  it("uses a trusted development task module without changing the workflow root", async () => {
    let invocation: StudyBuddyWorkflowInvocation | undefined;
    await executeStudyBuddyWorkflow(
      { args: ["diagnose", "test"], workspace: path.resolve("/workspace") },
      {
        packagedRoot: path.resolve("/study-buddy"),
        taskModulePath: path.resolve("/t3code-fork/scripts/study-buddy-packaged-task.mjs"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => ({}),
        spawnWorkflow: async (input) => {
          invocation = input;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(invocation?.args).toEqual([
      path.resolve("/t3code-fork/scripts/study-buddy-packaged-task.mjs"),
      "diagnose",
      "test",
    ]);
    expect(invocation?.environment.STUDY_BUDDY_ROOT).toBe(path.resolve("/study-buddy"));
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

  it("rejects path-bearing continuation commands before resolving secrets", async () => {
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
    ).rejects.toThrow("Unsupported Study Buddy workflow command");
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it.each(["prompt", "combined", "doc", "interactive-study-guide"])(
    "rejects wrapper-owned run directory overrides for %s",
    async (command) => {
      const resolveWorkflowEnvironment = vi.fn(async () => ({ MOODLE_PASSWORD: "not-used" }));
      const spawnWorkflow = vi.fn();

      await expect(
        executeStudyBuddyWorkflow(
          {
            args: [command, "test", "--run-dir", process.cwd()],
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
      ).rejects.toThrow("may not override --run-dir");
      expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
      expect(spawnWorkflow).not.toHaveBeenCalled();
    },
  );

  it("forwards a direct URL only after matching it to the server-selected source", async () => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({
      MOODLE_PASSWORD: "not-used",
      STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
    }));
    let invocation: StudyBuddyWorkflowInvocation | undefined;
    const spawnWorkflow = vi.fn(async (input: StudyBuddyWorkflowInvocation) => {
      invocation = input;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await executeStudyBuddyWorkflow(
      {
        args: ["prompt", "test", "--url=https://moodle.example.test/course/1"],
        workspace: path.resolve("/registered-workspace"),
      },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment,
        spawnWorkflow,
      },
    );
    expect(resolveWorkflowEnvironment).toHaveBeenCalledWith({
      args: ["prompt", "test", "--url=https://moodle.example.test/course/1"],
    });
    expect(invocation?.args).toEqual([
      path.resolve("/application/resources/study-buddy-runtime/bin/study_buddy_task.mjs"),
      "prompt",
      "test",
      "--url",
      "https://moodle.example.test/course/1",
    ]);
  });

  it("rejects a direct URL outside the server-selected source", async () => {
    const spawnWorkflow = vi.fn();

    await expect(
      executeStudyBuddyWorkflow(
        {
          args: ["prompt", "test", "--url", "https://attacker.example.test/course/1"],
          workspace: path.resolve("/workspace"),
        },
        {
          packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
          nodeExecutable: path.resolve("/application/study-buddy-t3code"),
          baseEnvironment: {},
          resolveWorkflowEnvironment: async () => ({
            STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
          }),
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow("outside the selected source");
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it("rejects path-valued approval inputs outside the workspace", async () => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({ MOODLE_PASSWORD: "not-used" }));
    const spawnWorkflow = vi.fn();

    await expect(
      executeStudyBuddyWorkflow(
        {
          args: ["prompt", "test", `--assignment-file=${process.cwd()}`],
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
    ).rejects.toThrow("may not override --assignment-file");
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });

  it("replaces an approved quiz request with a server-owned staged copy", async () => {
    const workflowEnvironment = {
      MOODLE_PASSWORD: "not-forwarded-in-argv",
      STUDY_BUDDY_MOODLE_URL: "https://moodle.example.test/my/",
    };
    const stageQuizPermissionRequest = vi.fn(async () => "/private/quiz-request.json");
    let invocation: StudyBuddyWorkflowInvocation | undefined;

    await executeStudyBuddyWorkflow(
      {
        args: ["prompt", "quiz", "--approve-quiz-request", "/workspace/request.json"],
        workspace: path.resolve("/workspace"),
      },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => workflowEnvironment,
        stageQuizPermissionRequest,
        spawnWorkflow: async (input) => {
          invocation = input;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(stageQuizPermissionRequest).toHaveBeenCalledWith({
      requestPath: "/workspace/request.json",
      workspace: path.resolve("/workspace"),
      workflowEnvironment,
    });
    expect(invocation?.args).toEqual([
      path.resolve("/application/resources/study-buddy-runtime/bin/study_buddy_task.mjs"),
      "prompt",
      "quiz",
      "--approve-quiz-request",
      "/private/quiz-request.json",
    ]);
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

  it("redacts JSON-escaped and URL-encoded credential forms", async () => {
    const secret = 'a"b\\c\n';
    const result = await executeStudyBuddyWorkflow(
      { args: ["diagnose", "test"], workspace: path.resolve("/workspace") },
      {
        packagedRoot: path.resolve("/application/resources/study-buddy-runtime"),
        nodeExecutable: path.resolve("/application/study-buddy-t3code"),
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => ({ MOODLE_PASSWORD: secret }),
        spawnWorkflow: async () => ({
          exitCode: 1,
          stdout: `${JSON.stringify({ password: secret })}\n${encodeURIComponent(secret)}`,
          stderr: "",
        }),
      },
    );

    expect(result.stdout).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(result.stdout).not.toContain(encodeURIComponent(secret));
    expect(result.stdout).toContain("[REDACTED]");
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

describe("direct native-owner tools", () => {
  it("prepares a real template through the broker and packaged CLI in the stable owner tree", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "broker-direct-doc-"));
    const appRoot = fileURLToPath(new URL("../../../../../..", import.meta.url));
    const prompt = 'Create concise notes. "Exact original"';
    const invocationSpy = vi.fn(spawnNativeWorkflow);
    try {
      const result = await executeStudyBuddyWorkflow(
        {
          args: ["doc", prompt, "--language", "en", "--execution-profile=quality"],
          workspace,
          threadId: "broker-call-id",
        },
        {
          packagedRoot: appRoot,
          taskModulePath: path.join(appRoot, "t3code-fork/scripts/study-buddy-packaged-task.mjs"),
          nodeExecutable: process.execPath,
          baseEnvironment: {
            PATH: process.env.PATH,
            STUDY_BUDDY_DOCUMENT_OWNER_THREAD_ID: "stable-owner",
            STUDY_BUDDY_WORKSPACE_KIND: "project",
          },
          resolveWorkflowEnvironment: async () => ({}),
          spawnWorkflow: invocationSpy,
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const prepared = JSON.parse(result.stdout);
      expect(prepared).toMatchObject({
        ok: true,
        kind: "direct_document",
        op: "prepare",
        status: "prepared",
        retry_count: 0,
      });
      expect(prepared.runDir).toContain(
        path.join(workspace, "study-buddy-data", "threads", "stable-owner", "direct-documents"),
      );
      const state = JSON.parse(
        await readFile(path.join(prepared.runDir, "direct-document.json"), "utf8"),
      );
      expect(state).toMatchObject({
        ownerThreadId: "stable-owner",
        prompt,
        status: "prepared",
        retry_count: 0,
        error_log: null,
      });
      expect(await readFile(prepared.templatePath, "utf8")).toContain(
        '#import "study-buddy-components.typ": *',
      );
      expect(await readFile(prepared.syntaxExamplePath, "utf8")).toContain(
        "frac(dif bold(q), dif t)",
      );
      expect(await readdir(path.join(workspace, "study-buddy-data", "threads"))).toEqual([
        "stable-owner",
      ]);
      expect(
        await readdir(path.join(workspace, "study-buddy-data", "threads", "stable-owner")),
      ).toEqual(["direct-documents"]);
      expect(invocationSpy).toHaveBeenCalledTimes(1);
      expect(invocationSpy.mock.calls[0]![0].args.slice(1)).toEqual([
        "document",
        JSON.stringify({ op: "prepare", prompt }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);
  it("normalizes the skill doc entry to exact original-prompt preparation without legacy stages", async () => {
    const spawnWorkflow = vi.fn(async (input: StudyBuddyWorkflowInvocation) => ({
      exitCode: 0,
      stdout: JSON.stringify({ command: input.args.slice(1) }),
      stderr: "",
    }));
    const resolveWorkflowEnvironment = vi.fn(async () => ({}));
    const result = await executeStudyBuddyWorkflow(
      {
        args: [
          "doc",
          "Expanded instruction",
          "--original-user-prompt",
          'Exact request "with quotes"',
          "--language=en",
          "--execution-profile",
          "quality",
        ],
        workspace: path.resolve("/workspace"),
        threadId: "owner",
      },
      {
        packagedRoot: path.resolve("/app"),
        nodeExecutable: process.execPath,
        baseEnvironment: { STUDY_BUDDY_DOCUMENT_OWNER_THREAD_ID: "owner" },
        resolveWorkflowEnvironment,
        spawnWorkflow,
      },
    );
    expect(JSON.parse(result.stdout).command).toEqual([
      "document",
      JSON.stringify({ op: "prepare", prompt: 'Exact request "with quotes"' }),
    ]);
    expect(resolveWorkflowEnvironment).toHaveBeenCalledWith({
      args: ["document", JSON.stringify({ op: "prepare", prompt: 'Exact request "with quotes"' })],
    });
    expect(spawnWorkflow).toHaveBeenCalledTimes(1);
    expect(spawnWorkflow.mock.calls[0]![0].environment.STUDY_BUDDY_DOCUMENT_OWNER_THREAD_ID).toBe(
      "owner",
    );
  });
  it.each([
    "--unknown",
    "--run-dir",
    "--codex-model",
    "--codex-reasoning-effort",
    "--profile-overrides-json",
    "--env",
    "--url",
  ])("rejects doc extra %s before resolving sources or spawning a workflow", async (option) => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({}));
    const spawnWorkflow = vi.fn();
    await expect(
      executeStudyBuddyWorkflow(
        { args: ["doc", "Exact request", option, "value"], workspace: path.resolve("/workspace") },
        {
          packagedRoot: path.resolve("/app"),
          nodeExecutable: process.execPath,
          baseEnvironment: {},
          resolveWorkflowEnvironment,
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow();
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });
  it.each(
    [
      ["--language"],
      ["--language=xx"],
      ["--language=en", "--language=de"],
      ["--original-user-prompt="],
      ["--original-user-prompt", "--language=en"],
      ["--execution-profile=../../outside"],
      ["extra-positional"],
      ["--env=INJECT=value"],
    ].map((extra) => ({ extra })),
  )("rejects malformed doc metadata $extra before resolving sources", async ({ extra }) => {
    const resolveWorkflowEnvironment = vi.fn(async () => ({}));
    const spawnWorkflow = vi.fn();
    await expect(
      executeStudyBuddyWorkflow(
        { args: ["doc", "Exact request", ...extra], workspace: path.resolve("/workspace") },
        {
          packagedRoot: path.resolve("/app"),
          nodeExecutable: process.execPath,
          baseEnvironment: {},
          resolveWorkflowEnvironment,
          spawnWorkflow,
        },
      ),
    ).rejects.toThrow();
    expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
    expect(spawnWorkflow).not.toHaveBeenCalled();
  });
  it.each([
    ["sources", '{"op":"courses","query":"topic"}'],
    ["document", '{"op":"prepare","prompt":"Create my study document"}'],
  ])("brokers %s without a worker profile or extra stage", async (command, payload) => {
    const spawnWorkflow = vi.fn(async (input: StudyBuddyWorkflowInvocation) => ({
      exitCode: 0,
      stdout: JSON.stringify({ command: input.args.slice(1) }),
      stderr: "",
    }));
    const result = await executeStudyBuddyWorkflow(
      { args: [command, payload], workspace: path.resolve("/workspace") },
      {
        packagedRoot: path.resolve("/app"),
        nodeExecutable: "/usr/bin/node",
        baseEnvironment: {},
        resolveWorkflowEnvironment: async () => ({ MOODLE_PASSWORD: "private-canary" }),
        spawnWorkflow,
      },
    );
    expect(JSON.parse(result.stdout).command).toEqual([command, payload]);
    expect(spawnWorkflow.mock.calls[0]![0].environment.STUDY_BUDDY_BROKER_EXECUTION).toBe("1");
  });
  it.each([
    ["sources", '{"op":"page","url":"https://example.edu","workspace":"/other"}'],
    ["sources", '{"op":"submit","url":"https://example.edu"}'],
    [
      "document",
      '{"op":"compile","runDir":"/workspace/run","environment":{"MOODLE_PASSWORD":"x"}}',
    ],
    ["document", "not-json"],
  ])(
    "rejects malformed or authority-overriding %s before resolving credentials",
    async (command, payload) => {
      const resolveWorkflowEnvironment = vi.fn(async () => ({}));
      const spawnWorkflow = vi.fn();
      await expect(
        executeStudyBuddyWorkflow(
          { args: [command, payload], workspace: path.resolve("/workspace") },
          {
            packagedRoot: path.resolve("/app"),
            nodeExecutable: "/usr/bin/node",
            baseEnvironment: {},
            resolveWorkflowEnvironment,
            spawnWorkflow,
          },
        ),
      ).rejects.toThrow("Direct Study Buddy");
      expect(resolveWorkflowEnvironment).not.toHaveBeenCalled();
      expect(spawnWorkflow).not.toHaveBeenCalled();
    },
  );
});
