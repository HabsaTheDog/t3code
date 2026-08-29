import { readFile } from "node:fs/promises";
import path from "node:path";

const BROKERED_COMMANDS = new Set([
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

function validRuntimeState(value) {
  return (
    value &&
    value.version === 1 &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535
  );
}

export async function maybeRunBrokeredWorkflow(
  args,
  {
    environment = process.env,
    cwd = process.cwd(),
    readRuntimeState = (filePath) => readFile(filePath, "utf8"),
    fetchImpl = globalThis.fetch,
    writeStdout = (value) => process.stdout.write(value),
    writeStderr = (value) => process.stderr.write(value),
  } = {},
) {
  if (environment.STUDY_BUDDY_BROKER_EXECUTION === "1" || !BROKERED_COMMANDS.has(args[0])) {
    return null;
  }
  const configRoot = environment.STUDY_BUDDY_CONFIG_ROOT?.trim();
  if (!configRoot) return null;

  let runtimeState;
  try {
    runtimeState = JSON.parse(await readRuntimeState(path.join(configRoot, "server-runtime.json")));
  } catch {
    writeStderr("Study Buddy's local workflow service is not ready. Restart the app and retry.\n");
    return 1;
  }
  if (!validRuntimeState(runtimeState)) {
    writeStderr("Study Buddy's local workflow service information is invalid.\n");
    return 1;
  }

  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${runtimeState.port}/api/study-buddy/workflow`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-study-buddy-workflow-client": "1",
        },
        body: JSON.stringify({
          args,
          workspace: environment.STUDY_BUDDY_WORKSPACE || cwd,
          ...(environment.STUDY_BUDDY_THREAD_ID || environment.CODEX_THREAD_ID
            ? { threadId: environment.STUDY_BUDDY_THREAD_ID || environment.CODEX_THREAD_ID }
            : {}),
        }),
      },
    );
    const result = await response.json();
    if (!response.ok || typeof result?.exitCode !== "number") {
      writeStderr(
        `${typeof result?.message === "string" ? result.message : "Study Buddy's local workflow service rejected the request."}\n`,
      );
      return 1;
    }
    if (typeof result.stdout === "string" && result.stdout) writeStdout(result.stdout);
    if (typeof result.stderr === "string" && result.stderr) writeStderr(result.stderr);
    return result.exitCode;
  } catch {
    writeStderr(
      "Study Buddy's local workflow service could not be reached. Restart the app and retry.\n",
    );
    return 1;
  }
}
