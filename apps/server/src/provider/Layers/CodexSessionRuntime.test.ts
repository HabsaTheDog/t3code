import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";
import { DEFAULT_MODEL, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  buildStudyBuddyDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  isRecoverableThreadResumeError,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("keeps full-access deterministic even when Study Buddy config is present", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Inspect the workspace",
      }),
    );

    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.sandboxPolicy, undefined);
    assert.deepStrictEqual(params.input, [{ type: "text", text: "Inspect the workspace" }]);
  });

  it("injects the saved personality when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
        personalityPrompt: "Be strict about correctness and call me Alex.",
      }),
    );

    assert.equal(params.collaborationMode?.mode, "default");
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /# User-defined agent behavior/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Be strict about correctness and call me Alex\./,
    );
  });

  it("injects Study Buddy developer instructions when the fork environment is active", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Was ist morgen im Labor?",
        cwd: "/tmp/selected-project",
        environment: {
          HOME: "/home/student",
          STUDY_BUDDY_ROOT: "/study-buddy",
          STUDY_BUDDY_T3_ROOT: "/study-buddy/t3code-fork",
        },
      }),
    );

    assert.equal(params.collaborationMode?.mode, "default");
    assert.equal(params.collaborationMode?.settings.model, DEFAULT_MODEL);
    assert.equal(params.collaborationMode?.settings.reasoning_effort, "medium");
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Study Buddy fork/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /enables the native `request_user_input` tool in Default mode/,
    );
    assert.doesNotMatch(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /request_user_input` tool is unavailable in Default mode/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Ordinary chat text such as `approve`, `allow`, or `yes` is not permission/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Do not send a final assistant response while this permission is pending/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /study_buddy_quiz_permission_v1/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Reuse that same approval-request path for every technical continuation run/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /\/home\/student\/\.agents\/skills\/study-buddy\/scripts\/study_buddy_task\.sh/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /\/tmp\/selected-project\/study-buddy-data\/<thread>\/runs\/<request-name>\/<timestamp>/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /\[descriptive-filename\.pdf\]\(\/tmp\/descriptive-filename\.pdf\)/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Never use a `file:\/\/` URL/,
    );
  });

  it("keeps the selected orchestrator model separate from the Study Buddy task policy", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Erstelle einen Lernzettel",
        cwd: "/tmp/selected-project",
        model: "gpt-5-codex",
        environment: {
          HOME: "/home/student",
          STUDY_BUDDY_ROOT: "/study-buddy",
        },
      }),
    );

    assert.equal(params.model, "gpt-5-codex");
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Explicit global Study Buddy model override: `none; use the task policy`/,
    );
    assert.doesNotMatch(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /--codex-model "gpt-5-codex"/,
    );
  });

  it("passes the saved execution profile to every Study Buddy workflow command", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Erstelle einen Lernzettel",
        cwd: "/tmp/selected-project",
        studyBuddyExecutionProfile: "quality",
        environment: {
          HOME: "/home/student",
          STUDY_BUDDY_ROOT: "/study-buddy",
        },
      }),
    );

    const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
    assert.match(instructions, /Active Study Buddy execution profile: `quality` \(`quality`\)/);
    assert.match(instructions, /doc "<prompt>" --execution-profile "quality"/);
    assert.match(
      instructions,
      /interactive-study-guide "<exact user prompt>" --execution-profile "quality"[\s\S]*canonical end-to-end route/,
    );
    assert.match(
      instructions,
      /extract "<source-focused prompt using the user's exact course words>" --execution-profile "quality"[\s\S]*--source-run-dir "<successful-extraction-run>"/,
    );
    assert.match(
      instructions,
      /never ask the user for a full course title before attempting evidence-based dashboard and course-page resolution/i,
    );
    assert.match(
      instructions,
      /inspect a bounded shortlist of plausible course pages, compare their descriptions, sections, and resources/i,
    );
    assert.match(
      instructions,
      /Never invoke the wrapper with an unassigned shell expansion such as `"\$SB_PROMPT"`/,
    );
    assert.match(instructions, /zero-length prompt must fail before any run directory/i);
  });

  it("passes a custom Quiz Solver role into Study Buddy wrapper commands", () => {
    const worker = {
      model: "gpt-worker",
      reasoningEffort: "medium" as const,
      retryModel: "gpt-worker-retry",
      retryReasoningEffort: "high" as const,
    };
    const instructions = buildStudyBuddyDeveloperInstructions({
      executionProfile: "custom",
      executionProfileConfig: {
        id: "custom-quiz",
        name: "Custom quiz",
        description: "Custom Quiz Solver profile",
        kind: "custom",
        roles: {
          coordinator: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-coordinator",
            reasoningEffort: "medium",
          },
          contentAnalyzer: worker,
          quizSolver: {
            model: "gpt-quiz",
            reasoningEffort: "high",
            retryModel: "gpt-quiz-retry",
            retryReasoningEffort: "xhigh",
          },
          artifactPlanner: worker,
          artifactBuilder: worker,
          qualityReviewer: worker,
        },
      },
      environment: {
        HOME: "/home/student",
        STUDY_BUDDY_ROOT: "/study-buddy",
      },
    });

    assert.match(instructions ?? "", /"quiz_solver":\{"model":"gpt-quiz"/);
    assert.match(instructions ?? "", /"retryModel":"gpt-quiz-retry"/);
  });

  it("documents an explicit Study Buddy global model override", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Erstelle einen Lernzettel",
        cwd: "/tmp/selected-project",
        model: "gpt-5-codex",
        environment: {
          HOME: "/home/student",
          STUDY_BUDDY_ROOT: "/study-buddy",
          STUDY_BUDDY_CODEX_MODEL: "gpt-5.6-terra",
        },
      }),
    );

    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /Explicit global Study Buddy model override: `gpt-5\.6-terra`/,
    );
    assert.match(
      params.collaborationMode?.settings.developer_instructions ?? "",
      /doc "<prompt>" --execution-profile "balanced" --codex-model "gpt-5\.6-terra"/,
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("selects a deterministic permission profile for every runtime mode", async () => {
    const cases = [
      ["approval-required", "study_buddy_analysis", "untrusted"],
      ["auto-accept-edits", "study_buddy", "on-request"],
      ["full-access", ":danger-full-access", "never"],
    ] as const;

    for (const [runtimeMode, expectedProfile, expectedApprovalPolicy] of cases) {
      let payload: CodexRpc.ClientRequestParamsByMethod["thread/start"] | undefined;
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          input: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/start") payload = input;
          return Effect.succeed(
            makeThreadOpenResponse(
              `thread-${runtimeMode}`,
            ) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      await Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make(`local-${runtimeMode}`),
          runtimeMode,
          cwd: "/tmp/project",
          requestedModel: undefined,
          serviceTier: undefined,
          resumeThreadId: undefined,
          studyBuddyActive: true,
        }),
      );

      assert.equal(payload?.approvalPolicy, expectedApprovalPolicy);
      assert.equal(payload?.approvalsReviewer, "user");
      assert.deepStrictEqual(payload?.config, { default_permissions: expectedProfile });
      assert.equal(payload?.sandbox, undefined);
    }
  });

  it("sends the selected permissions when opening a new thread", async () => {
    let payload: CodexRpc.ClientRequestParamsByMethod["thread/start"] | undefined;
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        input: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/start") payload = input;
        return Effect.succeed(
          makeThreadOpenResponse("secure-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-secure"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
        studyBuddyActive: true,
      }),
    );

    assert.equal(payload?.approvalPolicy, "never");
    assert.equal(payload?.sandbox, undefined);
    assert.deepStrictEqual(payload?.config, { default_permissions: ":danger-full-access" });
  });

  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
        studyBuddyActive: false,
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
          studyBuddyActive: false,
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
