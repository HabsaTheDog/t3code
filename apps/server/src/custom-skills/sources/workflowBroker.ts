// @effect-diagnostics nodeBuiltinImport:off -- This is the server-owned workflow process boundary.
import path from "node:path";

export const BROKERED_STUDY_BUDDY_COMMANDS = new Set([
  "prompt",
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
const SERVER_SELECTED_SOURCE_OPTIONS = new Set(["--calendar-url", "--cis-url", "--url"]);

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

function validateRequest(input: StudyBuddyWorkflowRequest): void {
  const [command] = input.args;
  if (!command || !BROKERED_STUDY_BUDDY_COMMANDS.has(command)) {
    throw new Error(`Unsupported Study Buddy workflow command: ${command || "<missing>"}.`);
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
  return [...new Set(secrets)]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (output, secret) => (secret.length > 0 ? output.split(secret).join("[REDACTED]") : output),
      value,
    );
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
    if (SERVER_SELECTED_SOURCE_OPTIONS.has(option)) {
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
  input: StudyBuddyWorkflowRequest,
  dependencies: StudyBuddyWorkflowBrokerDependencies,
): Promise<StudyBuddyWorkflowResult> {
  validateRequest(input);
  validateRejectedArgumentOverrides(input);
  const workflowEnvironment = await dependencies.resolveWorkflowEnvironment({
    args: input.args,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  });
  const sanitizedArgs = await sanitizeArgumentOverrides(input, dependencies, workflowEnvironment);
  const result = await dependencies.spawnWorkflow({
    command: dependencies.nodeExecutable,
    args: [path.join(dependencies.packagedRoot, "bin", "study_buddy_task.mjs"), ...sanitizedArgs],
    cwd: input.workspace,
    environment: {
      ...dependencies.baseEnvironment,
      ...workflowEnvironment,
      ELECTRON_RUN_AS_NODE: "1",
      STUDY_BUDDY_BROKER_EXECUTION: "1",
      STUDY_BUDDY_ROOT: dependencies.packagedRoot,
      STUDY_BUDDY_WORKSPACE: input.workspace,
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
