// @effect-diagnostics nodeBuiltinImport:off -- This is the server-owned workflow process boundary.
import { realpath } from "node:fs/promises";
import path from "node:path";

export const BROKERED_STUDY_BUDDY_COMMANDS = new Set([
  "prompt",
  "combined",
  "doc",
  "extract",
  "render",
  "interactive-study-guide",
  "interactive-study-guide-resume",
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
  "--calendar-url",
  "--cis-url",
  "--codex-path",
  "--deliver-to",
  "--out",
  "--request-name",
  "--run-dir",
  "--url",
]);

// These inputs are legitimate for explicit resume/approval flows, but must
// resolve to an existing object within the active registered workspace.
const CONTAINED_PATH_OPTIONS = new Set([
  "--approve-assignment-request",
  "--approve-quiz-request",
  "--asset",
  "--assignment-file",
  "--resume-extraction-run-dir",
  "--resume-run-dir",
  "--source-file",
  "--source-run-dir",
]);

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

async function validatePathArguments(input: StudyBuddyWorkflowRequest): Promise<void> {
  const [command, , runPath] = input.args;
  const workspace = path.resolve(input.workspace);

  const assertContained = async (candidate: string): Promise<void> => {
    const resolved = await realpath(path.resolve(workspace, candidate));
    const relative = path.relative(workspace, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Study Buddy workflow path must stay inside the active workspace.");
    }
  };

  if (runPath && (command === "render" || command === "interactive-study-guide-resume")) {
    await assertContained(runPath);
  }

  const optionStart = command === "render" || command === "interactive-study-guide-resume" ? 3 : 2;
  for (let index = optionStart; index < input.args.length; index += 1) {
    const argument = input.args[index] ?? "";
    const separator = argument.indexOf("=");
    const option = separator >= 0 ? argument.slice(0, separator) : argument;
    const inlineValue = separator >= 0 ? argument.slice(separator + 1) : undefined;

    if (REJECTED_OVERRIDE_OPTIONS.has(option)) {
      throw new Error(`Study Buddy workflow may not override ${option}.`);
    }
    if (!CONTAINED_PATH_OPTIONS.has(option)) continue;

    const candidate = inlineValue ?? input.args[index + 1];
    if (!candidate || (!inlineValue && candidate.startsWith("--"))) {
      throw new Error(`Study Buddy workflow option ${option} requires a path.`);
    }
    await assertContained(candidate);
    if (inlineValue === undefined) index += 1;
  }
}

export async function executeStudyBuddyWorkflow(
  input: StudyBuddyWorkflowRequest,
  dependencies: StudyBuddyWorkflowBrokerDependencies,
): Promise<StudyBuddyWorkflowResult> {
  validateRequest(input);
  await validatePathArguments(input);
  const workflowEnvironment = await dependencies.resolveWorkflowEnvironment({
    args: input.args,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  });
  const result = await dependencies.spawnWorkflow({
    command: dependencies.nodeExecutable,
    args: [path.join(dependencies.packagedRoot, "bin", "study_buddy_task.mjs"), ...input.args],
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
