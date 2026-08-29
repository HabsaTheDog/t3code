// @effect-diagnostics nodeBuiltinImport:off -- Owns the local packaged-workflow process boundary.
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { resolveStudyBuddyCodexPolicyPaths } from "../../provider/setup/studyBuddyCodexPolicy.ts";
import { createStudyBuddySourcePlatform } from "./sourcePlatform.ts";
import {
  executeStudyBuddyWorkflow,
  type StudyBuddyWorkflowInvocation,
  type StudyBuddyWorkflowRequest,
  type StudyBuddyWorkflowResult,
} from "./workflowBroker.ts";

export const STUDY_BUDDY_WORKFLOW_ROUTE = "/api/study-buddy/workflow";
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const SAFE_BASE_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PLAYWRIGHT_EXECUTABLE_PATH",
  "STUDY_BUDDY_BROWSER_EXECUTABLE",
]);

class StudyBuddyWorkflowBrokerRequestError extends Data.TaggedError(
  "StudyBuddyWorkflowBrokerRequestError",
)<{ readonly cause?: unknown }> {}

function safeBaseEnvironment(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] =>
          SAFE_BASE_ENVIRONMENT_NAMES.has(entry[0]) && Boolean(entry[1]),
      ),
    ),
    CODEX_HOME: codexHome,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(
    hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)]$/, "$1"),
  );
}

function decodeRequest(value: unknown): StudyBuddyWorkflowRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid workflow request.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.args) || !input.args.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid workflow arguments.");
  }
  if (typeof input.workspace !== "string") throw new Error("Invalid workflow workspace.");
  if (input.threadId !== undefined && typeof input.threadId !== "string") {
    throw new Error("Invalid workflow thread identifier.");
  }
  if (
    input.sourceIds !== undefined &&
    (!Array.isArray(input.sourceIds) ||
      !input.sourceIds.every((entry) => typeof entry === "string"))
  ) {
    throw new Error("Invalid workflow source identifiers.");
  }
  return {
    args: input.args,
    workspace: input.workspace,
    ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
    ...(Array.isArray(input.sourceIds) ? { sourceIds: input.sourceIds as string[] } : {}),
  };
}

function spawnWorkflow(
  invocation: StudyBuddyWorkflowInvocation,
): Promise<StudyBuddyWorkflowResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputLimitExceeded = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: outputLimitExceeded ? 1 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: outputLimitExceeded
          ? "Study Buddy workflow output exceeded the safe capture limit.\n"
          : Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export const studyBuddyWorkflowRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const sourcePlatform = createStudyBuddySourcePlatform(config, secretStore);
    const codexHome = resolveStudyBuddyCodexPolicyPaths(config).codexHome;

    return HttpRouter.add(
      "POST",
      STUDY_BUDDY_WORKFLOW_ROUTE,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (
          config.mode !== "desktop" ||
          Option.isNone(url) ||
          !isLoopbackHostname(url.value.hostname) ||
          request.headers["x-study-buddy-workflow-client"] !== "1"
        ) {
          return HttpServerResponse.jsonUnsafe(
            { message: "Study Buddy workflow request was not authorized." },
            { status: 403 },
          );
        }

        const nodeExecutable = process.env.STUDY_BUDDY_NODE_EXECUTABLE;
        const packagedRoot = process.env.STUDY_BUDDY_ROOT;
        if (!nodeExecutable || !packagedRoot) {
          return HttpServerResponse.jsonUnsafe(
            { message: "Study Buddy packaged workflow runtime is unavailable." },
            { status: 503 },
          );
        }

        const body = yield* request.json.pipe(Effect.option);
        if (Option.isNone(body)) {
          return HttpServerResponse.jsonUnsafe(
            { message: "Study Buddy workflow request body is invalid." },
            { status: 400 },
          );
        }

        const outcome = yield* Effect.tryPromise({
          try: async () => {
            const input = decodeRequest(body.value);
            const workspace = await realpath(path.resolve(input.workspace));
            if (!(await stat(workspace)).isDirectory()) {
              throw new StudyBuddyWorkflowBrokerRequestError({});
            }
            return executeStudyBuddyWorkflow(
              { ...input, workspace },
              {
                packagedRoot,
                nodeExecutable,
                baseEnvironment: safeBaseEnvironment(process.env, codexHome),
                resolveWorkflowEnvironment: (selection) =>
                  sourcePlatform.resolveWorkflowEnvironment(selection),
                spawnWorkflow,
              },
            );
          },
          catch: (cause) => new StudyBuddyWorkflowBrokerRequestError({ cause }),
        }).pipe(Effect.result);

        if (Result.isFailure(outcome)) {
          return HttpServerResponse.jsonUnsafe(
            { message: "Study Buddy could not start the requested workflow." },
            { status: 400 },
          );
        }
        return HttpServerResponse.jsonUnsafe(outcome.success, { status: 200 });
      }),
    );
  }),
);
