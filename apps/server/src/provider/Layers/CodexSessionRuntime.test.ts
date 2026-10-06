import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";
import { DEFAULT_MODEL, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  buildStudyBuddyDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  isRecoverableThreadResumeError,
  openCodexThread,
  sendCodexTurn,
  invalidateCodexInstructionDelivery,
  type CodexInstructionDelivery,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("native Study Buddy instruction transport", () => {
  function fixture(failInjection = false, failTurn = false) {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const delivery = Effect.runSync(Ref.make<CodexInstructionDelivery | undefined>(undefined));
    const client = {
      request: (
        _method: "thread/inject_items",
        payload: CodexRpc.ClientRequestParamsByMethod["thread/inject_items"],
      ): Effect.Effect<
        CodexRpc.ClientRequestResponsesByMethod["thread/inject_items"],
        CodexErrors.CodexAppServerError
      > => {
        calls.push({ method: "thread/inject_items", payload });
        return failInjection
          ? Effect.fail(
              new CodexErrors.CodexAppServerProtocolParseError({ detail: "injection refused" }),
            )
          : Effect.succeed({});
      },
      raw: {
        request: (
          _method: "turn/start",
          payload: unknown,
        ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> => {
          calls.push({ method: "turn/start", payload });
          return failTurn
            ? Effect.fail(
                new CodexErrors.CodexAppServerProtocolParseError({ detail: "model turn failed" }),
              )
            : Effect.succeed({ marker: "raw-turn-result" });
        },
      },
    };
    return { calls, client, delivery };
  }

  function appParams(
    personality = "Current user personality",
    threadId = "provider-thread-1",
    profileName = "Current selected profile",
    interactionMode: "plan" | "default" = "plan",
  ) {
    const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "current-custom");
    return Effect.runSync(
      buildTurnStartParams({
        threadId,
        runtimeMode: "approval-required",
        cwd: "/project",
        environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
        prompt: "Exact original prompt",
        model: "gpt-6.1-sol",
        effort: "high",
        interactionMode,
        personalityPrompt: personality,
        studyBuddyExecutionProfile: "custom",
        studyBuddyExecutionProfileConfig: { ...profile, name: profileName },
        attachments: [{ type: "image", url: "data:image/png;base64,abc" }],
      }),
    );
  }

  it("injects complete current profile/personality/mode before the actual turn without unsupported collaboration delivery", async () => {
    const params = appParams();
    const { client, calls, delivery } = fixture();
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/inject_items", "turn/start"],
    );
    const instructions = params.collaborationMode!.settings.developer_instructions;
    assert.deepStrictEqual(calls[0]?.payload, {
      threadId: params.threadId,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: instructions }],
        },
      ],
    });
    assert.match(instructions!, /Current selected profile/);
    assert.match(instructions!, /Current user personality/);
    assert.match(instructions!, /# Plan Mode \(Conversational\)/);
    assert.match(instructions!, /study_buddy_quiz_permission_v1/);
    const { collaborationMode: _mode, ...expectedTurn } = params;
    assert.deepStrictEqual(calls[1]?.payload, expectedTurn);
  });

  it("skips only exact same-thread instructions and reinjects changes or a new runtime", async () => {
    const { client, calls, delivery } = fixture();
    const params = appParams();
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    await Effect.runPromise(
      sendCodexTurn({
        client,
        params: appParams(
          "Changed personality",
          "provider-thread-1",
          "Changed selected profile",
          "default",
        ),
        studyBuddyActive: true,
        delivery,
      }),
    );
    await Effect.runPromise(
      sendCodexTurn({
        client,
        params: appParams(
          "Changed personality",
          "another-thread",
          "Changed selected profile",
          "default",
        ),
        studyBuddyActive: true,
        delivery,
      }),
    );
    const restarted = Effect.runSync(Ref.make<CodexInstructionDelivery | undefined>(undefined));
    await Effect.runPromise(
      sendCodexTurn({ client, params, studyBuddyActive: true, delivery: restarted }),
    );
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      [
        "thread/inject_items",
        "turn/start",
        "turn/start",
        "thread/inject_items",
        "turn/start",
        "thread/inject_items",
        "turn/start",
        "thread/inject_items",
        "turn/start",
      ],
    );
  });

  it("reinjects after its own compaction while unrelated thread compaction leaves delivery intact", async () => {
    const { client, calls, delivery } = fixture();
    const params = appParams();
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    await Effect.runPromise(invalidateCodexInstructionDelivery(delivery, "another-thread"));
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    await Effect.runPromise(invalidateCodexInstructionDelivery(delivery, params.threadId));
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery }));
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/inject_items", "turn/start", "turn/start", "thread/inject_items", "turn/start"],
    );
  });

  it("never sends a turn or caches delivery after failed injection", async () => {
    const { client, calls, delivery } = fixture(true);
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        Effect.runPromise(
          sendCodexTurn({ client, params: appParams(), studyBuddyActive: true, delivery }),
        ),
      );
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/inject_items", "thread/inject_items"],
    );
    assert.equal(Effect.runSync(Ref.get(delivery)), undefined);
  });

  it("retains a successful injection after model failure without creating another thread", async () => {
    const { client, calls, delivery } = fixture(false, true);
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        Effect.runPromise(
          sendCodexTurn({ client, params: appParams(), studyBuddyActive: true, delivery }),
        ),
      );
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/inject_items", "turn/start", "turn/start"],
    );
  });

  it("keeps non-Study Buddy turns unchanged without injecting instructions", async () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "hello",
        interactionMode: "default",
      }),
    );
    const { client, calls, delivery } = fixture();
    await Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: false, delivery }));
    assert.deepStrictEqual(calls, [{ method: "turn/start", payload: params }]);
    assert.equal(Effect.runSync(Ref.get(delivery)), undefined);
  });

  it("fails before any RPC when an app turn has no current instructions", async () => {
    const params = Effect.runSync(
      buildTurnStartParams({ threadId: "provider-thread-1", runtimeMode: "full-access" }),
    );
    const { client, calls, delivery } = fixture();
    await assert.rejects(
      Effect.runPromise(sendCodexTurn({ client, params, studyBuddyActive: true, delivery })),
    );
    assert.deepStrictEqual(calls, []);
  });
});

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
    const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
    const continuation =
      /Reuse that path for ([a-z/]+) of the same attempt until it finishes or the grant expires/.exec(
        instructions,
      );
    assert.ok(continuation, "quiz continuations must retain the original grant and its expiry");
    const operations = continuation[1];
    assert.ok(operations, "quiz continuation operations must be present");
    assert.deepEqual(
      operations.split("/").toSorted(),
      ["start", "read", "collect", "fill", "next", "complete", "recover"].toSorted(),
    );
    assert.match(instructions, /`permissionRequestPath` set to the original absolute request path/);
    assert.match(instructions, /Technical continuation does not authorize another start/);
    assert.match(instructions, /Final quiz submission remains blocked in every mode/);
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
      /Use the workflow's durable deliveryPath or publishedPath in the final Markdown link/,
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
    assert.match(
      instructions,
      /source-evidence "<exact user prompt>" --execution-profile "quality"/,
    );
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
    assert.match(instructions, /source-evidence/);
    assert.match(instructions, /user's actual request is the primary guide to scope/);
    assert.match(
      instructions,
      /do not force every request through a fixed source order, all-course crawl or answer template/,
    );
    assert.match(instructions, /Missing information is not evidence that nothing exists/);
    assert.match(
      instructions,
      /Narrow to dated deadlines only when the user requests that restriction/,
    );
    assert.match(
      instructions,
      /When that mapping or a date conflict remains unresolved, expose the actionable uncertainty/,
    );
    assert.match(instructions, /Acquisition completeness and answer completeness are separate/);
    assert.match(
      instructions,
      /establish which items are completed, outstanding or upcoming from the evidence/,
    );
    assert.match(instructions, /Write for the learner in ordinary language/);
    assert.match(
      instructions,
      /answer the complete original user request in your own words[\s\S]*native evidence handoff/i,
    );
    assert.match(
      instructions,
      /absence of a matching calendar event never proves that no task is due/,
    );
    assert.match(instructions, /workflow supervisor owns idle and runtime limits/);
    assert.match(
      instructions,
      /A `tool\.started` or `tool\.updated` event, yielded exec session, session ID, partial stdout, or stage-level error file is not terminal tool completion/,
    );
    assert.match(
      instructions,
      /Never send a final assistant response while that wrapper command or worker is still live/,
    );
    assert.match(
      instructions,
      /a final assistant response is forbidden until this contract passes or the same wrapper command has reached a terminal failure and its process has exited/,
    );
    assert.match(instructions, /If the workflow fails[\s\S]*must not claim that nothing is due/);
  });

  it("makes the app-owned Study Buddy wrapper authoritative over loaded skill paths", () => {
    const instructions = buildStudyBuddyDeveloperInstructions({
      environment: {
        HOME: "/home/student",
        STUDY_BUDDY_ROOT: "/study-buddy",
        STUDY_BUDDY_TASK_WRAPPER: "/study-buddy/t3code-fork/scripts/study-buddy-dev-task",
      },
    });

    assert.match(
      instructions ?? "",
      /Wrapper: `\/study-buddy\/t3code-fork\/scripts\/study-buddy-dev-task`/,
    );
    assert.match(
      instructions ?? "",
      /If a loaded skill, remembered command, or workspace document names a different Study Buddy wrapper, ignore that conflicting path/,
    );
    assert.doesNotMatch(
      instructions ?? "",
      /\/home\/student\/\.agents\/skills\/study-buddy\/scripts\/study_buddy_task\.sh/,
    );
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
      /prompt "<user prompt>" --execution-profile "balanced" --codex-model "gpt-5\.6-terra"/,
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
      assert.deepStrictEqual(payload?.config, {
        default_permissions: expectedProfile,
        "shell_environment_policy.set.STUDY_BUDDY_THREAD_ID": `local-${runtimeMode}`,
        "shell_environment_policy.set.STUDY_BUDDY_WORKSPACE": "/tmp/project",
      });
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
    assert.deepStrictEqual(payload?.config, {
      default_permissions: ":danger-full-access",
      "shell_environment_policy.set.STUDY_BUDDY_THREAD_ID": "thread-secure",
      "shell_environment_policy.set.STUDY_BUDDY_WORKSPACE": "/tmp/project",
    });
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
