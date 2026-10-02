import { readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";

// A broker responds when its supervised workflow finishes. Node fetch's implicit
// five-minute header deadline would disconnect and cancel a healthy long run.
// Workflow idle/runtime watchdogs and explicit user cancellation own its lifetime.
export function requestBroker(url, init) {
  return new Promise((resolve, reject) => {
    const client = request(url, { method: init.method, headers: init.headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("Workflow response interrupted")));
      response.once("end", () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    client.setTimeout(0);
    client.once("error", reject);
    client.end(init.body);
  });
}

const BROKERED_COMMANDS = new Set([
  "sources",
  "document",
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
const BLOCKED_PATH_COMMANDS = new Set(["render", "interactive-study-guide-resume"]);

function brokerSelection(args, environment) {
  const forwardedArgs = [];
  const sourceIds = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--study-buddy-source-id") {
      const sourceId = args[index + 1];
      if (sourceId) sourceIds.push(sourceId);
      index += 1;
      continue;
    }
    if (argument.startsWith("--study-buddy-source-id=")) {
      sourceIds.push(argument.slice("--study-buddy-source-id=".length));
      continue;
    }
    forwardedArgs.push(argument);
  }
  for (const sourceId of (environment.STUDY_BUDDY_SOURCE_IDS || "").split(",")) {
    if (sourceId.trim()) sourceIds.push(sourceId.trim());
  }
  return { forwardedArgs, sourceIds: [...new Set(sourceIds)] };
}

function validRuntimeState(value) {
  return (
    value &&
    value.version === 1 &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    typeof value.workflowToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.workflowToken)
  );
}

export async function maybeRunBrokeredWorkflow(
  args,
  {
    environment = process.env,
    cwd = process.cwd(),
    readRuntimeState = (filePath) => readFile(filePath, "utf8"),
    fetchImpl = requestBroker,
    writeStdout = (value) => new Promise((resolve) => process.stdout.write(value, resolve)),
    writeStderr = (value) => new Promise((resolve) => process.stderr.write(value, resolve)),
  } = {},
) {
  if (environment.STUDY_BUDDY_BROKER_EXECUTION === "1") {
    return null;
  }
  const runtimeStateRoot =
    environment.STUDY_BUDDY_RUNTIME_STATE_ROOT?.trim() ||
    environment.STUDY_BUDDY_CONFIG_ROOT?.trim();
  if (BLOCKED_PATH_COMMANDS.has(args[0]) && runtimeStateRoot) {
    await writeStderr(
      "This path-bearing continuation is unavailable in the packaged app. Use the atomic doc or interactive-study-guide workflow instead.\n",
    );
    return 1;
  }
  if (!BROKERED_COMMANDS.has(args[0])) return null;
  const selection = brokerSelection(args, environment);
  if (!runtimeStateRoot) return null;

  let runtimeState;
  try {
    runtimeState = JSON.parse(
      await readRuntimeState(path.join(runtimeStateRoot, "server-runtime.json")),
    );
  } catch {
    await writeStderr(
      "Study Buddy's local workflow service is not ready. Restart the app and retry.\n",
    );
    return 1;
  }
  if (!validRuntimeState(runtimeState)) {
    await writeStderr("Study Buddy's local workflow service information is invalid.\n");
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
          "x-study-buddy-workflow-token": runtimeState.workflowToken,
        },
        body: JSON.stringify({
          args: selection.forwardedArgs,
          workspace: environment.STUDY_BUDDY_WORKSPACE || cwd,
          ...(environment.STUDY_BUDDY_THREAD_ID || environment.CODEX_THREAD_ID
            ? { threadId: environment.STUDY_BUDDY_THREAD_ID || environment.CODEX_THREAD_ID }
            : {}),
          ...(selection.sourceIds.length > 0 ? { sourceIds: selection.sourceIds } : {}),
        }),
      },
    );
    const result = await response.json();
    if (!response.ok || typeof result?.exitCode !== "number") {
      await writeStderr(
        `${typeof result?.message === "string" ? result.message : "Study Buddy's local workflow service rejected the request."}\n`,
      );
      return 1;
    }
    if (typeof result.stdout === "string" && result.stdout) await writeStdout(result.stdout);
    if (typeof result.stderr === "string" && result.stderr) await writeStderr(result.stderr);
    return result.exitCode;
  } catch {
    await writeStderr(
      "Study Buddy's local workflow service could not be reached. Restart the app and retry.\n",
    );
    return 1;
  }
}
