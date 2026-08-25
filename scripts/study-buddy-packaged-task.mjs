#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  study_buddy_task prompt "<natural language prompt>" [extra args]
  study_buddy_task combined "<natural language prompt>" [extra args]
  study_buddy_task doc "<prompt>" [extra args]
  study_buddy_task extract "<prompt>" [extra args]
  study_buddy_task render "<prompt>" "<successful-extraction-run>" [extra args]
  study_buddy_task interactive-study-guide "<prompt>" [extra args]
  study_buddy_task interactive-study-guide-resume "<prompt>" <workflow-dir> [extra args]
  study_buddy_task cheat-sheet|assignment-brief|diagnose "<prompt>" [extra args]
  study_buddy_task quiz-url "<moodle quiz url>" [extra args]
  study_buddy_task cancel|status|checkpoint|wait "<run-dir>" [timeout-seconds]
  study_buddy_task root|workspace|data-root|output-root
`;

const COMBINED_SOURCE_PATTERN =
  /(morgen|heute|nächste|naechste|termin|stundenplan|timetable|schedule|einheit|unterricht|class|\bLV\b|lehrveranstaltung|fachlabor|labor|prüfung|pruefung|exam|deadline|abgabe|raum|gruppe|lektor|lektorin|anwesenheit)/iu;
const DETAILED_CIS_PATTERN =
  /(morgen|heute|nächste|naechste|termin|stundenplan|timetable|schedule|prüfung|pruefung|exam|deadline|abgabe|raum|gruppe|lektor|lektorin|anwesenheit)/iu;
const QUIZ_PATTERN =
  /(quiz|test|minitest|kurztest|testblock|selbstcheck|selfcheck|moodle\s*test)/iu;
const QUIZ_ACTION_PATTERN =
  /(mach|mache|bearbeit|füll|fuell|ausfüll|ausfuell|lös|loes|answer|solve|fill|complete|start)/iu;

const packagedRoot = path.resolve(
  process.env.STUDY_BUDDY_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const invocationCwd = process.cwd();
const workspace = realpathSync(
  path.resolve(process.env.STUDY_BUDDY_WORKSPACE ?? process.env.T3CODE_CWD ?? invocationCwd),
);
const dataRoot = path.join(workspace, "study-buddy-data");
let workspaceKind = process.env.STUDY_BUDDY_WORKSPACE_KIND ?? "";
const workspaceBase = path.basename(workspace);
const workspaceParentBase = path.basename(path.dirname(workspace));
if (!workspaceKind && workspaceParentBase === "quick-chats") workspaceKind = "quick-chat";
let threadId = process.env.STUDY_BUDDY_THREAD_ID ?? "";
if (workspaceKind === "quick-chat" && !threadId) threadId = workspaceBase;
if (!threadId) threadId = process.env.CODEX_THREAD_ID ?? "";
const safeThreadId = threadId
  .replace(/[^a-zA-Z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 120);
const threadDataRoot =
  workspaceKind === "quick-chat" ||
  (!workspaceKind &&
    threadId &&
    workspaceParentBase === "quick-chats" &&
    workspaceBase === threadId)
    ? dataRoot
    : safeThreadId
      ? path.join(dataRoot, "threads", safeThreadId)
      : dataRoot;
const outputRoot = path.join(threadDataRoot, "runs");
const artifactLockDir = path.join(threadDataRoot, "locks", ".artifact-workflow.lock");
const defaultMoodleUrl =
  process.env.STUDY_BUDDY_MOODLE_URL ?? "https://moodle.technikum-wien.at/my/";
const defaultCisUrl = process.env.STUDY_BUDDY_CIS_URL ?? "https://cis.technikum-wien.at/cis.php/";

process.env.STUDY_BUDDY_ROOT = packagedRoot;
process.env.STUDY_BUDDY_WORKSPACE = workspace;
process.env.STUDY_BUDDY_THREAD_ID = threadId;
process.env.STUDY_BUDDY_WORKSPACE_KIND = workspaceKind;

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
  return code;
}

function nonEmptyFile(filePath) {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return {};
  }
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function utcTimestamp() {
  return new Date().toISOString();
}

function runSlug(prompt) {
  const withoutUrls = prompt.replace(/https?:\/\/\S+/giu, "");
  return (
    withoutUrls
      .toLocaleLowerCase("de")
      .replace(/[^a-z0-9äöüß_-]+/giu, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 80) || "moodle-run"
  );
}

function prepareRunDir(prompt) {
  const timestamp = utcTimestamp().replace(/[:.]/g, "-");
  const runDir = path.join(outputRoot, runSlug(prompt), timestamp);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function resolveScript(scriptName) {
  const pkg = readJson(path.join(packagedRoot, "canonical-package.json"));
  const command = pkg.scripts?.[scriptName];
  const match = typeof command === "string" ? command.match(/^tsx\s+([^\s]+)(?:\s+(.*))?$/u) : null;
  if (!match?.[1]) throw new Error(`Unsupported packaged Study Buddy script: ${scriptName}`);
  return {
    entry: path.join(packagedRoot, match[1]),
    staticArgs: match[2]?.trim().split(/\s+/u).filter(Boolean) ?? [],
  };
}

function watchdogArguments(runDir, pid, environment = process.env) {
  return [
    "--run-dir",
    runDir,
    "--pid",
    String(pid),
    "--process-group-id",
    String(pid),
    "--idle-timeout-ms",
    environment.STUDY_BUDDY_EXTERNAL_IDLE_TIMEOUT_MS ?? "360000",
    "--max-runtime-ms",
    environment.STUDY_BUDDY_EXTERNAL_MAX_RUNTIME_MS ?? "5400000",
  ];
}

function spawnWorkflow(scriptName, args, runDir) {
  const { entry, staticArgs } = resolveScript(scriptName);
  const tsx = path.join(packagedRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, entry, ...staticArgs, ...args], {
    cwd: packagedRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`Could not start packaged Study Buddy script: ${scriptName}`);
  const watchdogLog = openSync(path.join(runDir, "watchdog.log"), "a");
  const watchdog = spawn(
    process.execPath,
    [
      tsx,
      path.join(packagedRoot, "src/custom-skills/moodle/runWatchdogCli.ts"),
      ...watchdogArguments(runDir, child.pid),
    ],
    {
      cwd: packagedRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", watchdogLog, watchdogLog],
      windowsHide: true,
    },
  );
  closeSync(watchdogLog);
  writeFileSync(
    path.join(runDir, "pid.json"),
    `${JSON.stringify(
      {
        wrapper_pid: process.pid,
        child_pid: child.pid,
        process_group_id: child.pid,
        started_at: utcTimestamp(),
        command: `packaged:${scriptName}`,
      },
      null,
      2,
    )}\n`,
  );
  const forwardSignal = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      // The workflow may have already exited.
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const stopWatchdog = () => {
    if (!watchdog.pid || !processAlive(watchdog.pid)) return;
    try {
      process.kill(watchdog.pid, "SIGTERM");
    } catch {
      // The watchdog may have already observed the completed child.
    }
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return new Promise((resolve, reject) => {
    watchdog.once("error", (error) => {
      forwardSignal("SIGTERM");
      reject(error);
    });
    child.once("error", (error) => {
      stopWatchdog();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      stopWatchdog();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function runAgentInDir(prompt, runDir, args) {
  mkdirSync(runDir, { recursive: true });
  console.log(`Run directory: ${runDir}`);
  return spawnWorkflow(
    "moodle:agent",
    [prompt, "--url", defaultMoodleUrl, "--run-dir", runDir, ...args],
    runDir,
  );
}

function acquireArtifactLock(workflowDir) {
  mkdirSync(path.dirname(artifactLockDir), { recursive: true });
  try {
    mkdirSync(artifactLockDir);
  } catch {
    const owner = readJson(path.join(artifactLockDir, "owner.json"));
    if (processAlive(owner.wrapper_pid)) {
      throw Object.assign(new Error("Another Study Buddy artifact workflow is active."), {
        code: 73,
      });
    }
    rmSync(artifactLockDir, { recursive: true, force: true });
    mkdirSync(artifactLockDir);
  }
  writeFileSync(
    path.join(artifactLockDir, "owner.json"),
    `${JSON.stringify({ wrapper_pid: process.pid, workflow_dir: workflowDir, started_at: utcTimestamp() })}\n`,
  );
}

function releaseArtifactLock() {
  rmSync(artifactLockDir, { recursive: true, force: true });
}

function isValidExtractionHandoff(runDir) {
  const summary = readText(path.join(runDir, "run-summary.md"));
  return (
    existsSync(runDir) &&
    nonEmptyFile(path.join(runDir, "extracted-data.json")) &&
    !nonEmptyFile(path.join(runDir, "error.log")) &&
    /^Route: extraction$/mu.test(summary) &&
    /^Run status: (success|partial)$/mu.test(summary)
  );
}

function sourceArgsFor(prompt) {
  if (!COMBINED_SOURCE_PATTERN.test(prompt)) return ["--no-cis"];
  return DETAILED_CIS_PATTERN.test(prompt)
    ? ["--cis-url", defaultCisUrl]
    : ["--cis-url", defaultCisUrl, "--max-cis-pages", "1"];
}

function extractSourceArgsFor(prompt) {
  return COMBINED_SOURCE_PATTERN.test(prompt) ? ["--cis-url", defaultCisUrl] : ["--no-cis"];
}

async function runStagedDocument(prompt, args) {
  const workflowArgs = args.some(
    (arg) => arg === "--execution-profile" || arg.startsWith("--execution-profile="),
  )
    ? args
    : [...args, "--execution-profile", "quality"];
  const workflowDir = prepareRunDir(prompt);
  const extractionDir = path.join(workflowDir, "extraction");
  const renderDir = path.join(workflowDir, "render");
  acquireArtifactLock(workflowDir);
  console.log(`Workflow directory: ${workflowDir}`);
  try {
    const extractionCode = await runAgentInDir(prompt, extractionDir, [
      "--stage",
      "extract",
      ...sourceArgsFor(prompt),
      ...workflowArgs,
    ]);
    if (extractionCode !== 0 || !isValidExtractionHandoff(extractionDir)) {
      return fail("Extraction did not produce a valid handoff; render stage will not start.");
    }
    const renderCode = await runAgentInDir(prompt, renderDir, [
      "--stage",
      "render",
      "--source-run-dir",
      extractionDir,
      "--max-pages",
      "0",
      "--max-cis-pages",
      "0",
      "--no-downloads",
      "--no-cis",
      ...workflowArgs,
    ]);
    if (renderCode === 0) console.log(`PDF ready: ${path.join(renderDir, "document.pdf")}`);
    return renderCode;
  } finally {
    releaseArtifactLock();
  }
}

function cancelRun(runDir) {
  const pidFile = path.join(runDir, "pid.json");
  if (!existsSync(pidFile)) return fail(`No pid.json found at: ${pidFile}`);
  const pid = Number(readJson(pidFile).process_group_id || readJson(pidFile).child_pid);
  if (!Number.isInteger(pid) || pid <= 0) return fail(`No process id found in: ${pidFile}`);
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
  }
  const summaryPath = path.join(runDir, "run-summary.md");
  if (existsSync(summaryPath)) {
    appendFileSync(summaryPath, `\nRun status: canceled\nCanceled at: ${utcTimestamp()}\n`);
  }
  return 0;
}

function runState(runDir) {
  if (!existsSync(runDir)) return { error: `Run directory not found: ${runDir}` };
  const pid = readJson(path.join(runDir, "pid.json")).child_pid;
  return { processState: pid ? (processAlive(pid) ? "running" : "stopped") : "unknown" };
}

function printStatus(runDir) {
  const state = runState(runDir);
  if (state.error) return fail(state.error);
  console.log(`Process: ${state.processState}`);
  const summary = readText(path.join(runDir, "run-summary.md"));
  console.log(summary || "Run summary: missing");
  for (const artifact of [
    "document.typ",
    "document.pdf",
    "error.log",
    "source_coverage.json",
    "run-events.jsonl",
  ]) {
    const candidate = path.join(runDir, artifact);
    console.log(
      `${artifact}: ${nonEmptyFile(candidate) ? "present" : existsSync(candidate) ? "empty" : "missing"}`,
    );
  }
  return 0;
}

function checkpoint(runDir) {
  const state = runState(runDir);
  if (state.error) return fail(state.error);
  const summary = readText(path.join(runDir, "run-summary.md"));
  const statuses = [...summary.matchAll(/^Run status:\s*(\S+)/gmu)];
  const terminalStatus = statuses.at(-1)?.[1] ?? "unknown";
  const config = readJson(path.join(runDir, "config.json"));
  const stage = config.stage ?? "all";
  const error = readText(path.join(runDir, "error.log")).trim();
  const completed =
    terminalStatus === "success" &&
    (stage === "extract"
      ? nonEmptyFile(path.join(runDir, "extracted-data.json"))
      : nonEmptyFile(path.join(runDir, "document.typ")) &&
        nonEmptyFile(path.join(runDir, "document.pdf"))) &&
    !error;
  const blocked =
    Boolean(error) ||
    ["failed", "timeout", "canceled"].includes(terminalStatus) ||
    (state.processState === "stopped" && !completed);
  const events = readText(path.join(runDir, "run-events.jsonl"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const lastEvent = events.at(-1);
  const lastSemanticEvent =
    [...events].toReversed().find((event) => event.phase !== "diagnostic") ?? lastEvent;
  console.log(
    JSON.stringify(
      {
        report: completed ? "completed" : blocked ? "blocked" : "progress",
        process_alive: state.processState === "running",
        terminal_status: terminalStatus,
        stage,
        phase: lastSemanticEvent?.phase ?? "starting",
        current_action: lastSemanticEvent?.message ?? "Run initialized",
        heartbeat_at: lastEvent?.timestamp ?? null,
        semantic_progress_at: lastSemanticEvent?.timestamp ?? null,
        next_action: completed
          ? "Validate and deliver artifacts"
          : blocked
            ? "Inspect blocker before retrying"
            : "Continue the same worker lease",
        blocker: error || (blocked ? `Process stopped with status ${terminalStatus}` : null),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function waitRun(runDir, timeoutSeconds = 900) {
  const startedAt = Date.now();
  while (runState(runDir).processState === "running") {
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      checkpoint(runDir);
      return fail(`Timed out waiting for Study Buddy run: ${runDir}`, 124);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  printStatus(runDir);
  const stage = readJson(path.join(runDir, "config.json")).stage ?? "all";
  if (stage === "extract") {
    return nonEmptyFile(path.join(runDir, "extracted-data.json")) &&
      !nonEmptyFile(path.join(runDir, "error.log"))
      ? 0
      : 1;
  }
  return nonEmptyFile(path.join(runDir, "document.typ")) &&
    nonEmptyFile(path.join(runDir, "document.pdf")) &&
    !nonEmptyFile(path.join(runDir, "error.log"))
    ? 0
    : 1;
}

function requirePrompt(args) {
  const prompt = args[0];
  if (!prompt?.trim())
    throw Object.assign(new Error("Study Buddy prompt must be non-empty."), { code: 2 });
  return prompt;
}

async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!action) return fail(USAGE, 2);
  if (action === "root") return console.log(packagedRoot) ?? 0;
  if (action === "workspace") return console.log(workspace) ?? 0;
  if (action === "data-root") return console.log(dataRoot) ?? 0;
  if (action === "output-root") return console.log(outputRoot) ?? 0;
  if (["help", "-h", "--help"].includes(action)) return console.log(USAGE) ?? 0;
  if (action === "cancel") return cancelRun(args[0] ?? "");
  if (action === "status") return printStatus(args[0] ?? "");
  if (action === "checkpoint") return checkpoint(args[0] ?? "");
  if (action === "wait") return waitRun(args[0] ?? "", Number(args[1] ?? 900));

  const prompt = requirePrompt(args);
  const extra = args.slice(1);
  if (action === "doc") return runStagedDocument(prompt, extra);
  if (action === "render") {
    const sourceRunDir = extra[0];
    if (!sourceRunDir || !isValidExtractionHandoff(sourceRunDir)) {
      return fail("Refusing to render: source run is not a valid terminal extraction handoff.");
    }
    const runDir = prepareRunDir(prompt);
    return runAgentInDir(prompt, runDir, [
      "--stage",
      "render",
      "--source-run-dir",
      sourceRunDir,
      "--max-pages",
      "0",
      "--max-cis-pages",
      "0",
      "--no-downloads",
      "--no-cis",
      ...extra.slice(1),
    ]);
  }
  if (action === "interactive-study-guide" || action === "interactive-study-guide-resume") {
    const resumeDir = action.endsWith("-resume") ? extra[0] : undefined;
    const runDir = resumeDir ? realpathSync(resumeDir) : prepareRunDir(prompt);
    acquireArtifactLock(runDir);
    try {
      return await spawnWorkflow(
        "interactive-study-guide",
        resumeDir
          ? [prompt, "--resume-run-dir", runDir, ...extra.slice(1)]
          : [prompt, "--url", defaultMoodleUrl, "--run-dir", runDir, ...extra],
        runDir,
      );
    } finally {
      releaseArtifactLock();
    }
  }

  const runDir = prepareRunDir(prompt);
  if (action === "combined")
    return runAgentInDir(prompt, runDir, ["--cis-url", defaultCisUrl, ...extra]);
  if (action === "extract")
    return runAgentInDir(prompt, runDir, [
      "--stage",
      "extract",
      ...extractSourceArgsFor(prompt),
      ...extra,
    ]);
  if (action === "cheat-sheet") return runAgentInDir(prompt, runDir, ["--no-cis", ...extra]);
  if (action === "assignment-brief")
    return runAgentInDir(prompt, runDir, [...sourceArgsFor(prompt), ...extra]);
  if (action === "quiz-url")
    return runAgentInDir(`bearbeite das Moodle Quiz ${prompt}`, runDir, [
      "--max-pages",
      "24",
      "--auto-answer",
      "--no-cis",
      ...extra,
    ]);
  if (action === "diagnose")
    return runAgentInDir(prompt, runDir, [
      "--cis-url",
      defaultCisUrl,
      "--diagnostic-only",
      ...extra,
    ]);
  if (action === "prompt") {
    const routeArgs =
      QUIZ_PATTERN.test(prompt) && QUIZ_ACTION_PATTERN.test(prompt)
        ? ["--max-pages", "24", "--auto-answer"]
        : sourceArgsFor(prompt);
    return runAgentInDir(prompt, runDir, [...routeArgs, ...extra]);
  }
  return fail(`Unknown action: ${action}\n${USAGE}`, 2);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const code = await main();
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), Number(error?.code) || 1);
  }
}

export { extractSourceArgsFor, main, watchdogArguments };
