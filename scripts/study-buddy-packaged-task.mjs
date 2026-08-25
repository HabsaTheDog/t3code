#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
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
let artifactLockHeld = false;
let artifactLockToken = "";
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
    const linkStats = lstatSync(filePath);
    const stats = statSync(filePath);
    return linkStats.isFile() && stats.isFile() && stats.size > 0;
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

function lexicalExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveContainedRegularFile(rootDir, filePath) {
  try {
    const realRoot = realpathSync(rootDir);
    const linkStats = lstatSync(filePath);
    const realFile = realpathSync(filePath);
    const relative = path.relative(realRoot, realFile);
    if (!linkStats.isFile() || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return realFile;
  } catch {
    return undefined;
  }
}

function readContainedText(rootDir, filePath) {
  const resolved = resolveContainedRegularFile(rootDir, filePath);
  return resolved ? readText(resolved) : "";
}

function readContainedJson(rootDir, filePath) {
  try {
    return JSON.parse(readContainedText(rootDir, filePath));
  } catch {
    return {};
  }
}

function nonEmptyContainedFile(rootDir, filePath) {
  const resolved = resolveContainedRegularFile(rootDir, filePath);
  return resolved ? nonEmptyFile(resolved) : false;
}

function inspectRunContract(runDir) {
  const realRunDir = realpathSync(runDir);
  const nonEmptyRunFile = (filePath) => nonEmptyContainedFile(realRunDir, filePath);
  const readRunText = (filePath) => readContainedText(realRunDir, filePath);
  const readRunJson = (filePath) => readContainedJson(realRunDir, filePath);
  const controlPaths = [
    "run-summary.md",
    "config.json",
    "run-progress.json",
    "interaction-result.json",
    "workflow-summary.json",
    "workflow-summary.md",
    "error.log",
  ].map((name) => path.join(runDir, name));
  const invalidControls = controlPaths.filter(
    (filePath) => lexicalExists(filePath) && !resolveContainedRegularFile(realRunDir, filePath),
  );
  const summary = readRunText(path.join(runDir, "run-summary.md"));
  const summaryStatuses = [...summary.matchAll(/^Run status:\s*(\S+)/gmu)];
  const summaryStatus = summaryStatuses.at(-1)?.[1] ?? "unknown";
  const route = [...summary.matchAll(/^Route:\s*(\S+)/gmu)].at(-1)?.[1];
  const config = readRunJson(path.join(runDir, "config.json"));
  const progressPath = path.join(runDir, "run-progress.json");
  const progress = readRunJson(progressPath);
  const hasProgress = nonEmptyRunFile(progressPath);
  const terminalStatuses = new Set(["success", "partial"]);
  const failureStatuses = new Set(["failed", "timeout", "canceled"]);
  const liveStatuses = new Set(["unknown", "queued", "running"]);
  const error = readRunText(path.join(runDir, "error.log")).trim();
  const interactionResultPath = path.join(runDir, "interaction-result.json");
  const interaction = readRunJson(interactionResultPath);
  const hasInteractionResult = nonEmptyRunFile(interactionResultPath);
  const workflowSummaryPath = path.join(runDir, "workflow-summary.json");
  const workflow = readRunJson(workflowSummaryPath);
  const hasWorkflowSummary = nonEmptyRunFile(workflowSummaryPath);
  const workflowMarkdown = readRunText(path.join(runDir, "workflow-summary.md"));
  const workflowMarkdownStatus =
    [...workflowMarkdown.matchAll(/^Run status:\s*(\S+)/gmu)].at(-1)?.[1] ?? "unknown";

  let terminalStatus = summaryStatus;
  let contract = "document";
  let expectedArtifacts = [];
  let extraMissingArtifacts = [];
  let contradiction = "";

  if (hasWorkflowSummary) {
    terminalStatus = typeof workflow.status === "string" ? workflow.status : "unknown";
    contract = "interactive_study_guide";
    expectedArtifacts = ["workflow-summary.json", "workflow-summary.md"];
    const root = path.resolve(runDir);
    const insideRoot = (raw, label, parentRaw, kind = "file") => {
      if (typeof raw !== "string" || !raw) {
        extraMissingArtifacts.push(label);
        return;
      }
      const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        contradiction = `${label} is outside the workflow directory`;
        return;
      }
      if (parentRaw) {
        const parent = path.resolve(
          path.isAbsolute(parentRaw) ? parentRaw : path.join(root, parentRaw),
        );
        const parentRelative = path.relative(parent, resolved);
        if (!parentRelative || parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
          contradiction = `${label} is inconsistent with its workflow branch directory`;
          return;
        }
      }
      try {
        const linkStats = lstatSync(resolved);
        const realResolved = realpathSync(resolved);
        const realRelative = path.relative(realRunDir, realResolved);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
          contradiction = `${label} resolves outside the workflow directory`;
          return;
        }
        if (parentRaw) {
          const parent = path.resolve(
            path.isAbsolute(parentRaw) ? parentRaw : path.join(root, parentRaw),
          );
          const realParent = realpathSync(parent);
          const realParentRelative = path.relative(realParent, realResolved);
          if (
            !realParentRelative ||
            realParentRelative.startsWith("..") ||
            path.isAbsolute(realParentRelative)
          ) {
            contradiction = `${label} resolves outside its workflow branch directory`;
            return;
          }
        }
        if (kind === "directory") {
          if (!linkStats.isDirectory() || !statSync(realResolved).isDirectory()) {
            extraMissingArtifacts.push(label);
          }
        } else if (!linkStats.isFile() || !statSync(realResolved).isFile()) {
          extraMissingArtifacts.push(label);
        } else {
          expectedArtifacts.push(relative);
        }
      } catch {
        extraMissingArtifacts.push(label);
      }
    };
    if (workflow.schemaVersion !== 1) {
      contradiction = `Unsupported workflow summary schema (${workflow.schemaVersion ?? "unknown"})`;
    } else if (!["queued", "running", "success", "failed"].includes(terminalStatus)) {
      contradiction = `Workflow summary has no recognized status (${terminalStatus})`;
    } else if (workflowMarkdownStatus !== terminalStatus) {
      contradiction = `Workflow summary JSON status ${terminalStatus} contradicts Markdown status ${workflowMarkdownStatus}`;
    } else if (path.resolve(workflow.runDir ?? "") !== root) {
      contradiction = "Workflow summary run directory does not match the inspected directory";
    } else if (terminalStatus === "success") {
      if (workflow.ok !== true || workflow.error) {
        contradiction = "Successful workflow summary has inconsistent ok/error fields";
      } else if (typeof workflow.webLayoutRunDir !== "string" || !workflow.webLayoutRunDir) {
        extraMissingArtifacts.push("webLayoutRunDir");
      } else {
        insideRoot(workflow.webLayoutRunDir, "webLayoutRunDir", undefined, "directory");
        insideRoot(workflow.outputPath, "outputPath", workflow.webLayoutRunDir);
        if (workflow.pdfRenderRunDir) {
          insideRoot(workflow.pdfRenderRunDir, "pdfRenderRunDir", undefined, "directory");
          insideRoot(workflow.pdfPath, "pdfPath", workflow.pdfRenderRunDir);
        } else if (workflow.pdfPath) {
          contradiction = "Workflow summary has a PDF path without a PDF branch directory";
        }
      }
    } else if (
      terminalStatus === "failed" &&
      (workflow.ok !== false || typeof workflow.error !== "string" || !workflow.error.trim())
    ) {
      contradiction = "Failed workflow summary has inconsistent ok/error fields";
    }
  } else if (hasInteractionResult) {
    const interactionStatus = interaction.ok === true ? "success" : "failed";
    terminalStatus = summaryStatus;
    contract = interaction.kind === "assignment" ? "interactive_assignment" : "interactive_quiz";
    expectedArtifacts =
      contract === "interactive_assignment"
        ? ["assignment-report.md", "assignment-report.json"]
        : ["quiz-review.typ", "quiz-review.json"];
    if (interaction.workflowStatus === "permission_required") {
      expectedArtifacts.push(
        contract === "interactive_assignment"
          ? "assignment-permission-request.json"
          : "quiz-permission-request.json",
      );
    }
    if (interaction.schemaVersion !== 1) {
      contradiction = `Unsupported interaction result schema (${interaction.schemaVersion ?? "unknown"})`;
    } else if (interaction.kind !== "quiz" && interaction.kind !== "assignment") {
      contradiction = `Unknown interaction kind (${interaction.kind ?? "unknown"})`;
    } else if (
      interaction.workflowStatus !== "completed" &&
      interaction.workflowStatus !== "permission_required"
    ) {
      contradiction = `Interactive workflow ended with ${interaction.workflowStatus ?? "unknown"}`;
    } else if (summaryStatus !== interactionStatus) {
      contradiction = `Interaction result status ${interactionStatus} contradicts run summary status ${summaryStatus}`;
    } else if (
      JSON.stringify(interaction.requiredArtifacts) !== JSON.stringify(expectedArtifacts)
    ) {
      contradiction = "Interaction result required-artifact contract is invalid";
    }
  } else {
    const progressStatus = typeof progress.status === "string" ? progress.status : "unknown";
    if (
      !terminalStatuses.has(summaryStatus) &&
      !failureStatuses.has(summaryStatus) &&
      !liveStatuses.has(summaryStatus)
    ) {
      contradiction = `Run summary has no recognized terminal status (${summaryStatus})`;
    } else if (
      hasProgress &&
      progressStatus !== summaryStatus &&
      !(liveStatuses.has(summaryStatus) && liveStatuses.has(progressStatus))
    ) {
      contradiction = `Run summary status ${summaryStatus} contradicts run-progress status ${progressStatus}`;
    }

    const stage = config.stage ?? "all";
    const intent = config.intentDecision?.intent ?? route;
    if (stage === "extract") {
      contract = "extract";
      expectedArtifacts = ["extracted-data.json"];
    } else if (config.diagnosticOnly === true || intent === "diagnostic") {
      contract = "diagnostic";
      expectedArtifacts = ["moodle_raw.txt", "source_coverage.json"];
    } else if (
      config.intentDecision?.wantsQuickAnswer === true ||
      intent === "quick_answer" ||
      intent === "schedule_answer"
    ) {
      contract = "answer";
      expectedArtifacts = ["answer.md", "answer.json"];
    } else {
      expectedArtifacts = ["document.typ", "document.pdf"];
    }

    if (hasProgress && progress.artifacts && typeof progress.artifacts === "object") {
      const root = path.resolve(runDir);
      for (const artifactPath of Object.values(progress.artifacts)) {
        if (typeof artifactPath !== "string" || !artifactPath) continue;
        const resolved = path.resolve(
          path.isAbsolute(artifactPath) ? artifactPath : path.join(root, artifactPath),
        );
        const relative = path.relative(root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          contradiction = `run-progress references an artifact outside the run directory: ${artifactPath}`;
          break;
        }
        try {
          const realArtifact = realpathSync(resolved);
          const realRelative = path.relative(realRunDir, realArtifact);
          if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
            contradiction = `run-progress references an artifact resolving outside the run directory: ${artifactPath}`;
            break;
          }
        } catch {
          // Missing paths are handled by the route-specific artifact contract.
        }
      }
    }
  }

  if (invalidControls.length > 0) {
    contradiction = `Run control file is not a contained regular file: ${path.basename(invalidControls[0])}`;
  }

  const missingArtifacts = [
    ...expectedArtifacts.filter((artifact) => !nonEmptyRunFile(path.join(runDir, artifact))),
    ...extraMissingArtifacts,
  ];
  const completed =
    (terminalStatus === "success" ||
      (terminalStatus === "partial" && ["extract", "diagnostic"].includes(contract))) &&
    !error &&
    !contradiction &&
    missingArtifacts.length === 0;
  return {
    completed,
    terminalStatus,
    stage: config.stage ?? (hasWorkflowSummary || hasInteractionResult ? "interactive" : "all"),
    route: hasWorkflowSummary
      ? "interactive_study_guide"
      : hasInteractionResult
        ? (interaction.kind ?? "interactive")
        : (route ?? config.intentDecision?.intent ?? "unknown"),
    contract,
    workflowStatus: hasWorkflowSummary
      ? terminalStatus
      : hasInteractionResult
        ? (interaction.workflowStatus ?? "unknown")
        : undefined,
    expectedArtifacts,
    missingArtifacts,
    error,
    contradiction,
  };
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
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readJson(path.join(artifactLockDir, "owner.json"));
    const detail = owner.wrapper_pid
      ? ` Owner pid=${Number(owner.wrapper_pid) || "unknown"}, workflow=${JSON.stringify(owner.workflow_dir ?? "unknown")}, started=${JSON.stringify(owner.started_at ?? "unknown")}.`
      : "";
    throw Object.assign(
      new Error(
        `Another Study Buddy artifact workflow is active, initializing, or left a stale lock.${detail} Reuse or wait for it; only remove a stale lock after verifying that its owner process is no longer running.`,
      ),
      { code: 73 },
    );
  }
  artifactLockHeld = true;
  artifactLockToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerTempPath = path.join(artifactLockDir, `owner.${artifactLockToken}.tmp`);
  try {
    writeFileSync(
      ownerTempPath,
      `${JSON.stringify({
        wrapper_pid: process.pid,
        workflow_dir: workflowDir,
        started_at: utcTimestamp(),
        lock_token: artifactLockToken,
      })}\n`,
      { mode: 0o600 },
    );
    renameSync(ownerTempPath, path.join(artifactLockDir, "owner.json"));
  } catch (error) {
    try {
      unlinkSync(ownerTempPath);
    } catch {
      // The temporary owner file may not have been created.
    }
    try {
      rmdirSync(artifactLockDir);
    } catch {
      // Preserve an unexpected non-empty lock directory for manual inspection.
    }
    artifactLockHeld = false;
    artifactLockToken = "";
    throw error;
  }
}

function releaseArtifactLock() {
  if (!artifactLockHeld) return;
  const ownerPath = path.join(artifactLockDir, "owner.json");
  const owner = readJson(ownerPath);
  if (artifactLockToken && owner.lock_token === artifactLockToken) {
    try {
      unlinkSync(ownerPath);
      rmdirSync(artifactLockDir);
    } catch {
      // Preserve an unexpected lock directory instead of deleting another owner's state.
    }
  }
  artifactLockHeld = false;
  artifactLockToken = "";
}

function isValidExtractionHandoff(runDir) {
  const summaryPath = path.join(runDir, "run-summary.md");
  const errorPath = path.join(runDir, "error.log");
  const extractionPath = path.join(runDir, "extracted-data.json");
  const summary = readContainedText(runDir, summaryPath);
  return (
    existsSync(runDir) &&
    nonEmptyContainedFile(runDir, extractionPath) &&
    !nonEmptyContainedFile(runDir, errorPath) &&
    (!lexicalExists(errorPath) || Boolean(resolveContainedRegularFile(runDir, errorPath))) &&
    Boolean(resolveContainedRegularFile(runDir, summaryPath)) &&
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
  const resolvedPidFile = resolveContainedRegularFile(runDir, pidFile);
  if (!resolvedPidFile) return fail(`No valid contained pid.json found at: ${pidFile}`);
  const pidData = readJson(resolvedPidFile);
  const pid = Number(pidData.process_group_id || pidData.child_pid);
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
  const resolvedSummaryPath = resolveContainedRegularFile(runDir, summaryPath);
  if (resolvedSummaryPath) {
    appendFileSync(resolvedSummaryPath, `\nRun status: canceled\nCanceled at: ${utcTimestamp()}\n`);
  }
  return 0;
}

function runState(runDir) {
  if (!existsSync(runDir)) return { error: `Run directory not found: ${runDir}` };
  const pidPath = path.join(runDir, "pid.json");
  if (!lexicalExists(pidPath)) return { processState: "unknown" };
  const resolvedPidPath = resolveContainedRegularFile(runDir, pidPath);
  if (!resolvedPidPath) return { error: "pid.json is not a contained regular control file" };
  const pid = readJson(resolvedPidPath).child_pid;
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return { error: "pid.json has no valid child process id" };
  }
  return { processState: pid ? (processAlive(pid) ? "running" : "stopped") : "unknown" };
}

function printStatus(runDir) {
  const state = runState(runDir);
  if (state.error) return fail(state.error);
  console.log(`Process: ${state.processState}`);
  const summary = readContainedText(runDir, path.join(runDir, "run-summary.md"));
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
  const contract = inspectRunContract(runDir);
  const transientWriteSkew =
    state.processState === "running" &&
    (/^Run summary status (?:success|partial) contradicts run-progress status (?:unknown|queued|running)$/.test(
      contract.contradiction,
    ) ||
      /^Interaction result status (?:success|failed) contradicts run summary status (?:unknown|queued|running)$/.test(
        contract.contradiction,
      ) ||
      /^Workflow summary JSON status (?:success|failed) contradicts Markdown status (?:queued|running)$/.test(
        contract.contradiction,
      ) ||
      /^Workflow summary JSON status (?:queued|running) contradicts Markdown status (?:success|failed)$/.test(
        contract.contradiction,
      ));
  const completed = contract.completed && state.processState !== "running";
  const blocked =
    Boolean(contract.error || (contract.contradiction && !transientWriteSkew)) ||
    ["failed", "timeout", "canceled"].includes(contract.terminalStatus) ||
    (state.processState !== "running" && !completed);
  const events = readContainedText(runDir, path.join(runDir, "run-events.jsonl"))
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
        terminal_status: contract.terminalStatus,
        stage: contract.stage,
        route: contract.route,
        contract: contract.contract,
        workflow_status: contract.workflowStatus ?? null,
        phase: lastSemanticEvent?.phase ?? "starting",
        current_action: lastSemanticEvent?.message ?? "Run initialized",
        heartbeat_at: lastEvent?.timestamp ?? null,
        semantic_progress_at: lastSemanticEvent?.timestamp ?? null,
        next_action: completed
          ? contract.workflowStatus === "permission_required"
            ? "Deliver the permission request and wait for explicit approval"
            : "Validate and deliver artifacts"
          : blocked
            ? "Inspect blocker before retrying"
            : transientWriteSkew || contract.completed
              ? "Wait for worker exit and final status flush"
              : "Continue the same worker lease",
        blocker: blocked
          ? contract.error ||
            contract.contradiction ||
            (contract.missingArtifacts.length
              ? `Missing required artifacts: ${contract.missingArtifacts.join(", ")}`
              : `Process stopped with status ${contract.terminalStatus}`)
          : null,
        expected_artifacts: contract.expectedArtifacts,
        missing_artifacts: contract.missingArtifacts,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function waitRun(runDir, timeoutSeconds = 900) {
  const startedAt = Date.now();
  while (true) {
    const state = runState(runDir);
    if (state.error) return fail(state.error);
    if (state.processState !== "running") break;
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      checkpoint(runDir);
      return fail(`Timed out waiting for Study Buddy run: ${runDir}`, 124);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  printStatus(runDir);
  return inspectRunContract(runDir).completed ? 0 : 1;
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

export { extractSourceArgsFor, inspectRunContract, main, watchdogArguments };
