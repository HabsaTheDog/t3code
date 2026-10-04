// @effect-diagnostics nodeBuiltinImport:off -- This is the server-owned workflow process boundary.
import path from "node:path";
import { readFile } from "node:fs/promises";

export const BROKERED_STUDY_BUDDY_COMMANDS = new Set([
  "sources",
  "document",
  "quiz",
  "prompt",
  "source-evidence",
  "combined",
  "doc",
  "extract",
  "interactive-study-guide",
  "cheat-sheet",
  "assignment-brief",
  "diagnose",
  "quiz-url",
  "source-runtime-probe",
]);

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 32_768;

// These values are owned by the server-side wrapper. Allowing a broker client
// to append a second occurrence could redirect a credential-bearing workflow
// to another output tree, executable, or remote source.
const REJECTED_OVERRIDE_OPTIONS = new Set([
  "--codex-path",
  "--deliver-to",
  "--out",
  "--approve-assignment-request",
  "--asset",
  "--assignment-file",
  "--request-name",
  "--resume-extraction-run-dir",
  "--resume-run-dir",
  "--run-dir",
  "--source-file",
  "--source-run-dir",
]);
const SERVER_SELECTED_SOURCE_OPTIONS = new Set(["--cis-url", "--url"]);
const STRIPPED_PRIVATE_SOURCE_OPTIONS = new Set(["--calendar-url"]);

export interface StudyBuddyWorkflowRequest {
  readonly args: readonly string[];
  readonly workspace: string;
  readonly threadId?: string;
  readonly sourceIds?: readonly string[];
}

export interface StudyBuddyWorkflowInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface StudyBuddyWorkflowResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StudyBuddyWorkflowBrokerDependencies {
  readonly packagedRoot: string;
  readonly taskModulePath?: string;
  readonly nodeExecutable: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly resolveWorkflowEnvironment: (input: {
    readonly sourceIds?: readonly string[];
    readonly args?: readonly string[];
  }) => Promise<Record<string, string>>;
  readonly stageQuizPermissionRequest?: (input: {
    readonly requestPath: string;
    readonly workspace: string;
    readonly workflowEnvironment: Readonly<Record<string, string>>;
  }) => Promise<string>;
  readonly spawnWorkflow: (
    invocation: StudyBuddyWorkflowInvocation,
  ) => Promise<StudyBuddyWorkflowResult>;
}

/** The default PDF entry prepares files for the native owner, never a worker chain. */
export function normalizeDocumentWorkflowRequest(
  input: StudyBuddyWorkflowRequest,
): StudyBuddyWorkflowRequest {
  if (input.args[0] !== "doc") return input;
  validateRequest(input);
  const prompt = input.args[1];
  if (!prompt?.trim()) throw new Error("Study Buddy doc prompt must be non-empty.");
  const metadata = new Map<string, string>();
  const allowed = new Set(["--original-user-prompt", "--language", "--execution-profile"]);
  for (let index = 2; index < input.args.length; index += 1) {
    const argument = input.args[index]!;
    const separator = argument.indexOf("=");
    const option = separator >= 0 ? argument.slice(0, separator) : argument;
    if (REJECTED_OVERRIDE_OPTIONS.has(option)) {
      throw new Error(`Study Buddy workflow may not override ${option}.`);
    }
    if (!allowed.has(option) || metadata.has(option)) {
      throw new Error(`Unsupported or duplicate Study Buddy doc option: ${option}.`);
    }
    const value = separator >= 0 ? argument.slice(separator + 1) : input.args[++index];
    if (!value?.trim() || (separator < 0 && value.startsWith("--"))) {
      throw new Error(`Study Buddy doc option ${option} requires a value.`);
    }
    if (option === "--language" && value !== "de" && value !== "en") {
      throw new Error("Study Buddy doc language must be de or en.");
    }
    if (option === "--execution-profile" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
      throw new Error("Study Buddy doc profile metadata is invalid.");
    }
    metadata.set(option, value);
  }
  // Language/profile are compatibility metadata for the native caller, not
  // runtime overrides. The selected app agent continues authoring this request.
  return {
    ...input,
    args: [
      "document",
      JSON.stringify({ op: "prepare", prompt: metadata.get("--original-user-prompt") ?? prompt }),
    ],
  };
}

function validateRequest(input: StudyBuddyWorkflowRequest): void {
  const [command] = input.args;
  if (!command || !BROKERED_STUDY_BUDDY_COMMANDS.has(command)) {
    throw new Error(`Unsupported Study Buddy workflow command: ${command || "<missing>"}.`);
  }
  if (
    command === "quiz-url" ||
    // Match the packaged wrapper's existing implicit --auto-answer route too.
    // This only refuses that obsolete route; the native owner chooses the target.
    (command === "prompt" &&
      /(quiz|test|minitest|kurztest|testblock|selbstcheck|selfcheck|moodle\s*test)/iu.test(
        input.args[1] ?? "",
      ) &&
      /(mach|mache|bearbeit|füll|fuell|ausfüll|ausfuell|lös|loes|answer|solve|fill|complete|start)/iu.test(
        input.args[1] ?? "",
      )) ||
    input.args
      .slice(2)
      .some((argument) => argument === "--auto-answer" || argument.startsWith("--auto-answer="))
  ) {
    throw new Error(
      'Quiz execution is agent-owned. Use sources JSON tools to discover the exact quiz, then quiz with op:"inspect". Continue with the direct quiz start/read/fill/next/recover tools; legacy --auto-answer and quiz-url worker routes are unavailable in the app.',
    );
  }
  if (command === "sources" || command === "document" || command === "quiz") {
    if (command === "quiz" && !input.threadId?.trim()) {
      throw new Error("Direct quiz tools require an owning native thread.");
    }
    if (input.args.length !== 2) {
      throw new Error("Direct Study Buddy tools require exactly one JSON request.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(input.args[1] ?? "");
    } catch {
      throw new Error("Direct Study Buddy tool request must be JSON.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Direct Study Buddy tool request must be an object.");
    }
    const request = payload as Record<string, unknown>;
    const allowed =
      command === "sources"
        ? {
            courses: ["op", "query"],
            page: ["op", "url"],
            download: ["op", "url", "sourceID", "resourceID"],
            text: ["op", "sourceID", "pages"],
            pages: ["op", "sourceID", "pages"],
          }
        : command === "quiz"
          ? {
              inspect: ["op", "url", "prompt"],
              start: ["op", "runDir", "permissionRequestPath"],
              read: ["op", "runDir", "page", "permissionRequestPath"],
              fill: ["op", "runDir", "answers", "packetDigest", "permissionRequestPath"],
              next: ["op", "runDir", "permissionRequestPath"],
              recover: ["op", "runDir", "permissionRequestPath"],
              status: ["op", "runDir"],
            }
          : {
              prepare: ["op", "prompt"],
              compile: ["op", "runDir"],
              publish: ["op", "runDir", "filename"],
            };
    const keys = allowed[request.op as keyof typeof allowed] as readonly string[] | undefined;
    if (!keys || Object.keys(request).some((key) => !keys.includes(key))) {
      throw new Error("Direct Study Buddy tool request has an unsupported operation or field.");
    }
  }
  if (!path.isAbsolute(input.workspace)) {
    throw new Error("Study Buddy workflow workspace must be an absolute path.");
  }
  if (input.args.length > MAX_ARGUMENTS) {
    throw new Error("Study Buddy workflow has too many arguments.");
  }
  if (
    input.args.some((argument) => argument.length > MAX_ARGUMENT_LENGTH || argument.includes("\0"))
  ) {
    throw new Error("Study Buddy workflow contains an invalid argument.");
  }
  if (input.sourceIds?.some((sourceId) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sourceId))) {
    throw new Error("Study Buddy workflow contains an invalid source identifier.");
  }
}

function redact(value: string, secrets: readonly string[]): string {
  const variants = secrets.flatMap((secret) =>
    secret.length > 0
      ? [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]
      : [],
  );
  return [...new Set(variants)]
    .sort((left, right) => right.length - left.length)
    .reduce((output, secret) => output.split(secret).join("[REDACTED]"), value);
}

async function sanitizeArgumentOverrides(
  input: StudyBuddyWorkflowRequest,
  dependencies: StudyBuddyWorkflowBrokerDependencies,
  workflowEnvironment: Readonly<Record<string, string>>,
): Promise<string[]> {
  const sanitized = input.args.slice(0, 2);
  for (let index = 2; index < input.args.length; index += 1) {
    const argument = input.args[index] ?? "";
    const separator = argument.indexOf("=");
    const option = separator >= 0 ? argument.slice(0, separator) : argument;
    const inlineValue = separator >= 0 ? argument.slice(separator + 1) : undefined;

    if (REJECTED_OVERRIDE_OPTIONS.has(option)) {
      throw new Error(`Study Buddy workflow may not override ${option}.`);
    }
    if (STRIPPED_PRIVATE_SOURCE_OPTIONS.has(option)) {
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (SERVER_SELECTED_SOURCE_OPTIONS.has(option)) {
      const candidate = inlineValue ?? input.args[index + 1];
      if (!candidate || (!inlineValue && candidate.startsWith("--"))) {
        throw new Error(`Study Buddy workflow option ${option} requires a URL.`);
      }
      const trustedUrl = validateSelectedSourceUrl(option, candidate, workflowEnvironment);
      sanitized.push(option, trustedUrl);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (option === "--approve-quiz-request") {
      const requestPath = inlineValue ?? input.args[index + 1];
      if (!requestPath || (!inlineValue && requestPath.startsWith("--"))) {
        throw new Error("Study Buddy workflow option --approve-quiz-request requires a path.");
      }
      if (!dependencies.stageQuizPermissionRequest) {
        throw new Error("Study Buddy quiz permission staging is unavailable.");
      }
      const stagedPath = await dependencies.stageQuizPermissionRequest({
        requestPath,
        workspace: input.workspace,
        workflowEnvironment,
      });
      sanitized.push("--approve-quiz-request", stagedPath);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    sanitized.push(argument);
  }
  return sanitized;
}

function validateSelectedSourceUrl(
  option: string,
  candidate: string,
  workflowEnvironment: Readonly<Record<string, string>>,
): string {
  const url = new URL(candidate);
  if (url.username || url.password) {
    throw new Error(`Study Buddy workflow option ${option} may not contain URL credentials.`);
  }
  const values =
    option === "--url"
      ? [
          workflowEnvironment.STUDY_BUDDY_MOODLE_URL,
          workflowEnvironment.MOODLE_BASE_URL,
          workflowEnvironment.MOODLE_DASHBOARD_URL,
          ...(workflowEnvironment.MOODLE_LOGIN_ALLOWED_ORIGINS ?? "").split(","),
        ]
      : [
          workflowEnvironment.STUDY_BUDDY_CIS_URL,
          workflowEnvironment.CIS_BASE_URL,
          workflowEnvironment.CIS_DASHBOARD_URL,
          ...(workflowEnvironment.CIS_LOGIN_ALLOWED_ORIGINS ?? "").split(","),
        ];
  const allowedOrigins = new Set(
    values.flatMap((value) => {
      try {
        return value?.trim() ? [new URL(value.trim()).origin] : [];
      } catch {
        return [];
      }
    }),
  );
  if (!allowedOrigins.has(url.origin)) {
    throw new Error(`Study Buddy workflow option ${option} is outside the selected source.`);
  }
  return url.toString();
}

function validateRejectedArgumentOverrides(input: StudyBuddyWorkflowRequest): void {
  for (let index = 2; index < input.args.length; index += 1) {
    const argument = input.args[index] ?? "";
    const separator = argument.indexOf("=");
    const option = separator >= 0 ? argument.slice(0, separator) : argument;
    if (REJECTED_OVERRIDE_OPTIONS.has(option)) {
      throw new Error(`Study Buddy workflow may not override ${option}.`);
    }
  }
}

export async function executeStudyBuddyWorkflow(
  rawInput: StudyBuddyWorkflowRequest,
  dependencies: StudyBuddyWorkflowBrokerDependencies,
): Promise<StudyBuddyWorkflowResult> {
  const input = normalizeDocumentWorkflowRequest(rawInput);
  validateRequest(input);
  validateRejectedArgumentOverrides(input);
  const workflowEnvironment = await dependencies.resolveWorkflowEnvironment({
    args: input.args,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  });
  let sanitizedArgs = await sanitizeArgumentOverrides(input, dependencies, workflowEnvironment);
  const approvedQuizRequestIds: string[] = [];
  if (input.args[0] === "quiz") {
    const request = JSON.parse(input.args[1]!) as Record<string, unknown>;
    if (request.op === "inspect" && typeof request.url === "string") {
      request.url = validateSelectedSourceUrl("--url", request.url, workflowEnvironment);
    }
    if (request.permissionRequestPath !== undefined) {
      if (
        typeof request.permissionRequestPath !== "string" ||
        !request.permissionRequestPath.trim()
      )
        throw new Error("Direct quiz permission request path must be non-empty.");
      if (!dependencies.stageQuizPermissionRequest)
        throw new Error("Study Buddy quiz permission staging is unavailable.");
      const stagedPath = await dependencies.stageQuizPermissionRequest({
        requestPath: request.permissionRequestPath,
        workspace: input.workspace,
        workflowEnvironment,
      });
      const staged = JSON.parse(await readFile(stagedPath, "utf8")) as { requestId?: unknown };
      if (typeof staged.requestId !== "string" || !staged.requestId.trim())
        throw new Error("Server-staged quiz approval has no request identity.");
      request.permissionRequestPath = stagedPath;
      approvedQuizRequestIds.push(staged.requestId);
    }
    sanitizedArgs = ["quiz", JSON.stringify(request)];
  }
  const result = await dependencies.spawnWorkflow({
    command: dependencies.nodeExecutable,
    args: [
      dependencies.taskModulePath ??
        path.join(dependencies.packagedRoot, "bin", "study_buddy_task.mjs"),
      ...sanitizedArgs,
    ],
    cwd: input.workspace,
    environment: {
      ...dependencies.baseEnvironment,
      ...workflowEnvironment,
      ELECTRON_RUN_AS_NODE: "1",
      STUDY_BUDDY_BROKER_EXECUTION: "1",
      STUDY_BUDDY_ROOT: dependencies.packagedRoot,
      STUDY_BUDDY_WORKSPACE: input.workspace,
      STUDY_BUDDY_QUIZ_APPROVED_REQUEST_IDS: JSON.stringify(approvedQuizRequestIds),
      ...(dependencies.baseEnvironment.STUDY_BUDDY_QUIZ_ATTEMPT_LEDGER_ROOT
        ? {
            STUDY_BUDDY_QUIZ_ATTEMPT_LEDGER_ROOT:
              dependencies.baseEnvironment.STUDY_BUDDY_QUIZ_ATTEMPT_LEDGER_ROOT,
          }
        : {}),
      ...(input.threadId ? { STUDY_BUDDY_THREAD_ID: input.threadId } : {}),
    },
  });
  const secretValues = Object.entries(workflowEnvironment).flatMap(([name, value]) =>
    /(USERNAME|PASSWORD|PASSCODE|TOKEN|SECRET|API_KEY|CALENDAR_URL|BEARER_URL)$/i.test(name)
      ? [value]
      : [],
  );
  return {
    exitCode: result.exitCode,
    stdout: redact(result.stdout, secretValues),
    stderr: redact(result.stderr, secretValues),
  };
}
