// @effect-diagnostics nodeBuiltinImport:off -- Owns the local packaged-workflow process boundary.
// @effect-diagnostics globalTimers:off -- Native child-process escalation must outlive Effect scopes.
// @effect-diagnostics globalDate:off -- Permission expiry is wall-clock security state.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveStudyBuddyCodexPolicyPaths } from "../../provider/setup/studyBuddyCodexPolicy.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import { createStudyBuddySourcePlatform } from "./sourcePlatform.ts";
import {
  executeStudyBuddyWorkflow,
  type StudyBuddyWorkflowInvocation,
  type StudyBuddyWorkflowRequest,
  type StudyBuddyWorkflowResult,
} from "./workflowBroker.ts";

export const STUDY_BUDDY_WORKFLOW_ROUTE = "/api/study-buddy/workflow";
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const PROCESS_TREE_KILL_GRACE_MS = 2_000;
const MAX_PERMISSION_REQUEST_BYTES = 64 * 1024;
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

export async function stageQuizPermissionRequest(input: {
  readonly requestPath: string;
  readonly workspace: string;
  readonly workflowEnvironment: Readonly<Record<string, string>>;
  readonly stateDir: string;
}): Promise<string> {
  const sourcePath = await realpath(path.resolve(input.workspace, input.requestPath));
  const relative = path.relative(input.workspace, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Study Buddy quiz permission must originate in the active workspace.");
  }
  const details = await stat(sourcePath);
  if (!details.isFile() || details.size <= 0 || details.size > MAX_PERMISSION_REQUEST_BYTES) {
    throw new Error("Study Buddy quiz permission request has an invalid size or type.");
  }
  const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  if (
    parsed.version !== 1 ||
    parsed.owner !== "study-buddy" ||
    parsed.action !== "execute_quiz_attempt" ||
    parsed.scope !== "exact_quiz_attempt" ||
    parsed.status !== "pending" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.targetUrl !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    Date.parse(parsed.expiresAt) <= Date.now()
  ) {
    throw new Error("Study Buddy quiz permission request is invalid or expired.");
  }
  const allowedOrigins = new Set(
    [
      input.workflowEnvironment.STUDY_BUDDY_MOODLE_URL,
      input.workflowEnvironment.MOODLE_BASE_URL,
      input.workflowEnvironment.MOODLE_DASHBOARD_URL,
      ...(input.workflowEnvironment.MOODLE_LOGIN_ALLOWED_ORIGINS ?? "").split(","),
    ].flatMap((value) => {
      try {
        return value?.trim() ? [new URL(value.trim()).origin] : [];
      } catch {
        return [];
      }
    }),
  );
  if (!allowedOrigins.has(new URL(parsed.targetUrl).origin)) {
    throw new Error("Study Buddy quiz permission target is outside the selected Moodle source.");
  }
  const stagingRoot = path.join(input.stateDir, "workflow-approvals");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700).catch(() => undefined);
  const stagedPath = path.join(stagingRoot, `quiz-${parsed.requestId}-${randomUUID()}.json`);
  await writeFile(stagedPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(stagedPath, 0o600).catch(() => undefined);
  return stagedPath;
}

interface WorkflowTreeKillResult {
  readonly error?: Error;
  readonly status: number | null;
}

type SpawnSyncProcess = (
  command: string,
  args: readonly string[],
  options: { readonly windowsHide: boolean; readonly stdio: "ignore" },
) => WorkflowTreeKillResult;

export function terminateWorkflowTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  spawnSyncProcess: SpawnSyncProcess = spawnSync,
  killProcess: typeof process.kill = process.kill,
): (() => void) | undefined {
  if (!child.pid) {
    child.kill();
    return undefined;
  }
  if (platform === "win32") {
    const result = spawnSyncProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.error || result.status !== 0) child.kill();
    return undefined;
  }
  try {
    killProcess(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const escalation = setTimeout(() => {
    try {
      killProcess(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, PROCESS_TREE_KILL_GRACE_MS);
  escalation.unref();
  return () => clearTimeout(escalation);
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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputLimitExceeded = false;
    let cancelKillEscalation: (() => void) | undefined;
    const capture = (target: Buffer[], chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        if (outputLimitExceeded) return;
        outputLimitExceeded = true;
        cancelKillEscalation = terminateWorkflowTree(child);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      cancelKillEscalation?.();
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
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const codexHome = resolveStudyBuddyCodexPolicyPaths(config).codexHome;

    return HttpRouter.add(
      "POST",
      STUDY_BUDDY_WORKFLOW_ROUTE,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (
          config.mode !== "desktop" ||
          Option.isNone(url) ||
          Option.isNone(runtimeState) ||
          !isLoopbackHostname(url.value.hostname) ||
          request.headers["x-study-buddy-workflow-client"] !== "1" ||
          request.headers["x-study-buddy-workflow-token"] !== runtimeState.value.workflowToken
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

        const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(Effect.option);
        if (Option.isNone(snapshot)) {
          return HttpServerResponse.jsonUnsafe(
            { message: "Study Buddy could not verify the requested workspace." },
            { status: 503 },
          );
        }

        const outcome = yield* Effect.tryPromise({
          try: async () => {
            const input = decodeRequest(body.value);
            const workspace = await realpath(path.resolve(input.workspace));
            if (!(await stat(workspace)).isDirectory()) {
              throw new StudyBuddyWorkflowBrokerRequestError({});
            }
            const allowedWorkspaceRoots = [
              ...snapshot.value.projects
                .filter((project) => project.deletedAt === null)
                .map((project) => project.workspaceRoot),
              ...snapshot.value.threads
                .filter((thread) => thread.deletedAt === null && thread.worktreePath)
                .map((thread) => thread.worktreePath!),
            ];
            const canonicalAllowedRoots = (
              await Promise.all(
                allowedWorkspaceRoots.map(async (allowedRoot) => {
                  try {
                    return await realpath(path.resolve(allowedRoot));
                  } catch {
                    return null;
                  }
                }),
              )
            ).filter((allowedRoot): allowedRoot is string => allowedRoot !== null);
            if (
              !canonicalAllowedRoots.some(
                (allowedRoot) => path.relative(allowedRoot, workspace) === "",
              )
            ) {
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
                stageQuizPermissionRequest: (permission) =>
                  stageQuizPermissionRequest({ ...permission, stateDir: config.stateDir }),
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
