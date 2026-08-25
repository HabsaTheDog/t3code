import { assert, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectRunContract } from "./study-buddy-packaged-task.mjs";

const adapterPath = fileURLToPath(new URL("./study-buddy-packaged-task.mjs", import.meta.url));

it("uses route-aware packaged completion contracts and rejects stale artifacts", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "study-buddy-packaged-contract-"));
  try {
    const answerRun = path.join(temp, "answer");
    mkdirSync(answerRun);
    writeFileSync(
      path.join(answerRun, "run-summary.md"),
      "Route: quick_answer\nRun status: success\n",
    );
    writeFileSync(path.join(answerRun, "error.log"), "");
    writeFileSync(
      path.join(answerRun, "config.json"),
      JSON.stringify({
        stage: "all",
        intentDecision: { intent: "quick_answer", wantsQuickAnswer: true },
      }),
    );
    writeFileSync(
      path.join(answerRun, "run-progress.json"),
      JSON.stringify({ status: "success", artifacts: {} }),
    );
    writeFileSync(path.join(answerRun, "answer.md"), "answer\n");
    writeFileSync(path.join(answerRun, "answer.json"), "{}\n");
    assert.deepStrictEqual(inspectRunContract(answerRun), {
      completed: true,
      terminalStatus: "success",
      stage: "all",
      route: "quick_answer",
      contract: "answer",
      workflowStatus: undefined,
      expectedArtifacts: ["answer.md", "answer.json"],
      missingArtifacts: [],
      error: "",
      contradiction: "",
    });

    const staleRun = path.join(temp, "stale");
    mkdirSync(staleRun);
    writeFileSync(path.join(staleRun, "run-summary.md"), "Route: render\nRun status: failed\n");
    writeFileSync(path.join(staleRun, "error.log"), "");
    writeFileSync(
      path.join(staleRun, "config.json"),
      JSON.stringify({ stage: "render", intentDecision: { intent: "render" } }),
    );
    writeFileSync(
      path.join(staleRun, "run-progress.json"),
      JSON.stringify({ status: "failed", artifacts: {} }),
    );
    writeFileSync(path.join(staleRun, "document.typ"), "stale\n");
    writeFileSync(path.join(staleRun, "document.pdf"), "stale\n");
    assert.isFalse(inspectRunContract(staleRun).completed);

    const partialAnswer = path.join(temp, "partial-answer");
    mkdirSync(partialAnswer);
    writeFileSync(
      path.join(partialAnswer, "run-summary.md"),
      "Route: quick_answer\nRun status: partial\n",
    );
    writeFileSync(path.join(partialAnswer, "error.log"), "");
    writeFileSync(
      path.join(partialAnswer, "config.json"),
      JSON.stringify({
        stage: "all",
        intentDecision: { intent: "quick_answer", wantsQuickAnswer: true },
      }),
    );
    writeFileSync(
      path.join(partialAnswer, "run-progress.json"),
      JSON.stringify({ status: "partial", artifacts: {} }),
    );
    writeFileSync(path.join(partialAnswer, "answer.md"), "partial\n");
    writeFileSync(path.join(partialAnswer, "answer.json"), "{}\n");
    assert.isFalse(inspectRunContract(partialAnswer).completed);
    const partialCheckpoint = spawnSync(
      process.execPath,
      [adapterPath, "checkpoint", partialAnswer],
      { encoding: "utf8" },
    );
    assert.deepInclude(JSON.parse(partialCheckpoint.stdout), { report: "blocked" });
    const partialWait = spawnSync(process.execPath, [adapterPath, "wait", partialAnswer, "1"], {
      encoding: "utf8",
    });
    assert.equal(partialWait.status, 1, partialWait.stderr);

    const activeRun = path.join(temp, "active");
    mkdirSync(activeRun);
    writeFileSync(path.join(activeRun, "run-summary.md"), "Run status: running\n");
    writeFileSync(path.join(activeRun, "error.log"), "");
    writeFileSync(
      path.join(activeRun, "config.json"),
      JSON.stringify({
        stage: "all",
        intentDecision: { intent: "quick_answer", wantsQuickAnswer: true },
      }),
    );
    writeFileSync(
      path.join(activeRun, "run-progress.json"),
      JSON.stringify({ status: "running", artifacts: {} }),
    );
    assert.deepStrictEqual(inspectRunContract(activeRun), {
      completed: false,
      terminalStatus: "running",
      stage: "all",
      route: "quick_answer",
      contract: "answer",
      workflowStatus: undefined,
      expectedArtifacts: ["answer.md", "answer.json"],
      missingArtifacts: ["answer.md", "answer.json"],
      error: "",
      contradiction: "",
    });
    writeFileSync(
      path.join(activeRun, "pid.json"),
      `${JSON.stringify({ child_pid: process.pid })}\n`,
    );
    writeFileSync(
      path.join(activeRun, "run-progress.json"),
      JSON.stringify({ status: "queued", artifacts: {} }),
    );
    const activeCheckpoint = spawnSync(process.execPath, [adapterPath, "checkpoint", activeRun], {
      encoding: "utf8",
    });
    assert.equal(activeCheckpoint.status, 0, activeCheckpoint.stderr);
    assert.deepStrictEqual(JSON.parse(activeCheckpoint.stdout), {
      report: "progress",
      process_alive: true,
      terminal_status: "running",
      stage: "all",
      route: "quick_answer",
      contract: "answer",
      workflow_status: null,
      phase: "starting",
      current_action: "Run initialized",
      heartbeat_at: null,
      semantic_progress_at: null,
      next_action: "Continue the same worker lease",
      blocker: null,
      expected_artifacts: ["answer.md", "answer.json"],
      missing_artifacts: ["answer.md", "answer.json"],
    });

    const terminalWriteSkew = path.join(temp, "terminal-write-skew");
    mkdirSync(terminalWriteSkew);
    writeFileSync(
      path.join(terminalWriteSkew, "run-summary.md"),
      "Route: quick_answer\nRun status: success\n",
    );
    writeFileSync(path.join(terminalWriteSkew, "error.log"), "");
    writeFileSync(
      path.join(terminalWriteSkew, "config.json"),
      JSON.stringify({
        stage: "all",
        intentDecision: { intent: "quick_answer", wantsQuickAnswer: true },
      }),
    );
    writeFileSync(
      path.join(terminalWriteSkew, "run-progress.json"),
      JSON.stringify({ status: "running", artifacts: {} }),
    );
    writeFileSync(path.join(terminalWriteSkew, "answer.md"), "answer\n");
    writeFileSync(path.join(terminalWriteSkew, "answer.json"), "{}\n");
    assert.deepStrictEqual(inspectRunContract(terminalWriteSkew), {
      completed: false,
      terminalStatus: "success",
      stage: "all",
      route: "quick_answer",
      contract: "answer",
      workflowStatus: undefined,
      expectedArtifacts: ["answer.md", "answer.json"],
      missingArtifacts: [],
      error: "",
      contradiction: "Run summary status success contradicts run-progress status running",
    });
    writeFileSync(
      path.join(terminalWriteSkew, "pid.json"),
      `${JSON.stringify({ child_pid: process.pid })}\n`,
    );
    const liveSkewCheckpoint = spawnSync(
      process.execPath,
      [adapterPath, "checkpoint", terminalWriteSkew],
      { encoding: "utf8" },
    );
    assert.equal(liveSkewCheckpoint.status, 0, liveSkewCheckpoint.stderr);
    assert.deepInclude(JSON.parse(liveSkewCheckpoint.stdout), {
      report: "progress",
      process_alive: true,
      blocker: null,
    });
    writeFileSync(
      path.join(terminalWriteSkew, "pid.json"),
      `${JSON.stringify({ child_pid: 2_147_483_647 })}\n`,
    );
    const deadSkewCheckpoint = spawnSync(
      process.execPath,
      [adapterPath, "checkpoint", terminalWriteSkew],
      { encoding: "utf8" },
    );
    assert.equal(deadSkewCheckpoint.status, 0, deadSkewCheckpoint.stderr);
    assert.deepInclude(JSON.parse(deadSkewCheckpoint.stdout), {
      report: "blocked",
      process_alive: false,
    });
    const deadSkewWait = spawnSync(
      process.execPath,
      [adapterPath, "wait", terminalWriteSkew, "1"],
      { encoding: "utf8" },
    );
    assert.equal(deadSkewWait.status, 1, deadSkewWait.stderr);

    const canceledInteraction = path.join(temp, "canceled-interaction");
    mkdirSync(canceledInteraction);
    writeFileSync(
      path.join(canceledInteraction, "run-summary.md"),
      "Route: interactive_quiz\nRun status: canceled\n",
    );
    writeFileSync(path.join(canceledInteraction, "error.log"), "");
    writeFileSync(path.join(canceledInteraction, "quiz-review.typ"), "review\n");
    writeFileSync(path.join(canceledInteraction, "quiz-review.json"), "{}\n");
    writeFileSync(
      path.join(canceledInteraction, "interaction-result.json"),
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        workflowStatus: "completed",
        kind: "quiz",
        requiredArtifacts: ["quiz-review.typ", "quiz-review.json"],
      }),
    );
    assert.include(
      inspectRunContract(canceledInteraction).contradiction,
      "contradicts run summary status canceled",
    );

    const nativeArtifactDirectory = path.join(temp, "native-artifact-directory");
    mkdirSync(nativeArtifactDirectory);
    writeFileSync(
      path.join(nativeArtifactDirectory, "run-summary.md"),
      "Route: interactive_quiz\nRun status: success\n",
    );
    writeFileSync(path.join(nativeArtifactDirectory, "error.log"), "");
    writeFileSync(path.join(nativeArtifactDirectory, "quiz-review.json"), "{}\n");
    mkdirSync(path.join(nativeArtifactDirectory, "quiz-review.typ"));
    writeFileSync(
      path.join(nativeArtifactDirectory, "interaction-result.json"),
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        workflowStatus: "completed",
        kind: "quiz",
        requiredArtifacts: ["quiz-review.typ", "quiz-review.json"],
      }),
    );
    assert.isFalse(inspectRunContract(nativeArtifactDirectory).completed);
    const nativeDirectoryCheckpoint = spawnSync(
      process.execPath,
      [adapterPath, "checkpoint", nativeArtifactDirectory],
      { encoding: "utf8" },
    );
    assert.deepInclude(JSON.parse(nativeDirectoryCheckpoint.stdout), { report: "blocked" });
    const nativeDirectoryWait = spawnSync(
      process.execPath,
      [adapterPath, "wait", nativeArtifactDirectory, "1"],
      { encoding: "utf8" },
    );
    assert.equal(nativeDirectoryWait.status, 1, nativeDirectoryWait.stderr);

    const createControlSymlinkRun = (name, controlName) => {
      const runDir = path.join(temp, name);
      mkdirSync(runDir);
      writeFileSync(
        path.join(runDir, "run-summary.md"),
        `${controlName === "config.json" ? "Route: document" : "Route: quick_answer"}\nRun status: success\n`,
      );
      writeFileSync(path.join(runDir, "error.log"), "");
      writeFileSync(
        path.join(runDir, "config.json"),
        JSON.stringify({
          stage: "all",
          intentDecision: { intent: "quick_answer", wantsQuickAnswer: true },
        }),
      );
      writeFileSync(
        path.join(runDir, "run-progress.json"),
        JSON.stringify({ status: "success", artifacts: {} }),
      );
      writeFileSync(path.join(runDir, "answer.md"), "answer\n");
      writeFileSync(path.join(runDir, "answer.json"), "{}\n");
      const external = path.join(temp, `${name}-external-control`);
      writeFileSync(external, readFileSync(path.join(runDir, controlName), "utf8"));
      rmSync(path.join(runDir, controlName));
      symlinkSync(external, path.join(runDir, controlName));
      return runDir;
    };
    for (const runDir of [
      createControlSymlinkRun("summary-symlink", "run-summary.md"),
      createControlSymlinkRun("config-symlink", "config.json"),
    ]) {
      assert.isFalse(inspectRunContract(runDir).completed);
      const controlCheckpoint = spawnSync(process.execPath, [adapterPath, "checkpoint", runDir], {
        encoding: "utf8",
      });
      assert.deepInclude(JSON.parse(controlCheckpoint.stdout), { report: "blocked" });
      const controlWait = spawnSync(process.execPath, [adapterPath, "wait", runDir, "1"], {
        encoding: "utf8",
      });
      assert.equal(controlWait.status, 1, controlWait.stderr);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("fails closed on an ownerless packaged artifact lock", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "study-buddy-packaged-lock-"));
  const workspace = path.join(temp, "workspace");
  const packagedRoot = path.join(temp, "root");
  const lockDir = path.join(workspace, "study-buddy-data", "locks", ".artifact-workflow.lock");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(packagedRoot, { recursive: true });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "sentinel"), "preserve\n");
    const result = spawnSync(
      process.execPath,
      [adapterPath, "interactive-study-guide", "lock test"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          STUDY_BUDDY_ROOT: packagedRoot,
          STUDY_BUDDY_WORKSPACE: workspace,
          STUDY_BUDDY_THREAD_ID: "",
          STUDY_BUDDY_WORKSPACE_KIND: "",
          CODEX_THREAD_ID: "",
        },
      },
    );
    assert.equal(result.status, 73, result.stderr);
    assert.include(result.stderr, "active, initializing, or left a stale lock");
    assert.isTrue(existsSync(path.join(lockDir, "sentinel")));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("validates packaged interactive Study Guide workflow-root completion", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "study-buddy-packaged-guide-"));
  const createGuide = ({ name, status, html = false, pdf = false, outputPath }) => {
    const runDir = path.join(temp, name);
    const webLayoutRunDir = path.join(runDir, "web-layout");
    const pdfRenderRunDir = pdf ? path.join(runDir, "pdf-render") : undefined;
    const htmlPath = outputPath ?? path.join(webLayoutRunDir, "document.html");
    mkdirSync(webLayoutRunDir, { recursive: true });
    if (html) writeFileSync(htmlPath, "<!doctype html><title>Study Guide</title>\n");
    if (pdfRenderRunDir) {
      mkdirSync(pdfRenderRunDir, { recursive: true });
      writeFileSync(path.join(pdfRenderRunDir, "document.pdf"), "pdf\n");
    }
    writeFileSync(
      path.join(runDir, "workflow-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        status,
        ok: status === "success",
        runDir,
        webLayoutRunDir,
        pdfRenderRunDir,
        outputPath: htmlPath,
        pdfPath: pdfRenderRunDir ? path.join(pdfRenderRunDir, "document.pdf") : undefined,
        error: status === "failed" ? "render failed" : undefined,
      })}\n`,
    );
    writeFileSync(path.join(runDir, "workflow-summary.md"), `Run status: ${status}\n`);
    return runDir;
  };
  try {
    for (const runDir of [
      createGuide({ name: "html", status: "success", html: true }),
      createGuide({ name: "pdf", status: "success", html: true, pdf: true }),
    ]) {
      assert.deepInclude(inspectRunContract(runDir), {
        completed: true,
        terminalStatus: "success",
        contract: "interactive_study_guide",
        workflowStatus: "success",
      });
      const waited = spawnSync(process.execPath, [adapterPath, "wait", runDir, "1"], {
        encoding: "utf8",
      });
      assert.equal(waited.status, 0, waited.stderr);
    }

    const outsidePath = path.join(temp, "outside.html");
    writeFileSync(outsidePath, "outside\n");
    const htmlDirectory = createGuide({ name: "html-directory", status: "success" });
    const htmlDirectoryPath = path.join(htmlDirectory, "web-layout", "not-an-html-file");
    mkdirSync(htmlDirectoryPath);
    const htmlDirectorySummary = JSON.parse(
      readFileSync(path.join(htmlDirectory, "workflow-summary.json"), "utf8"),
    );
    htmlDirectorySummary.outputPath = htmlDirectoryPath;
    writeFileSync(
      path.join(htmlDirectory, "workflow-summary.json"),
      `${JSON.stringify(htmlDirectorySummary)}\n`,
    );
    const pdfDirectory = createGuide({
      name: "pdf-directory",
      status: "success",
      html: true,
      pdf: true,
    });
    const pdfDirectoryPath = path.join(pdfDirectory, "pdf-render", "document.pdf");
    rmSync(pdfDirectoryPath);
    mkdirSync(pdfDirectoryPath);
    const symlinkedHtml = createGuide({ name: "symlink", status: "success" });
    const symlinkTarget = path.join(temp, "outside-symlink-target.html");
    writeFileSync(symlinkTarget, "outside\n");
    symlinkSync(symlinkTarget, path.join(symlinkedHtml, "web-layout", "document.html"));
    for (const runDir of [
      createGuide({ name: "missing", status: "success" }),
      createGuide({ name: "outside", status: "success", outputPath: outsidePath }),
      createGuide({ name: "failed", status: "failed", html: true }),
      htmlDirectory,
      pdfDirectory,
      symlinkedHtml,
    ]) {
      assert.isFalse(inspectRunContract(runDir).completed);
      const waited = spawnSync(process.execPath, [adapterPath, "wait", runDir, "1"], {
        encoding: "utf8",
      });
      assert.equal(waited.status, 1, waited.stderr);
    }

    const live = createGuide({ name: "live", status: "running" });
    writeFileSync(path.join(live, "pid.json"), `${JSON.stringify({ child_pid: process.pid })}\n`);
    const checkpoint = spawnSync(process.execPath, [adapterPath, "checkpoint", live], {
      encoding: "utf8",
    });
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    assert.deepInclude(JSON.parse(checkpoint.stdout), {
      report: "progress",
      process_alive: true,
      contract: "interactive_study_guide",
      blocker: null,
    });

    const resumeSkew = createGuide({ name: "resume-skew", status: "success", html: true });
    writeFileSync(path.join(resumeSkew, "workflow-summary.md"), "Run status: running\n");
    writeFileSync(
      path.join(resumeSkew, "pid.json"),
      `${JSON.stringify({ child_pid: process.pid })}\n`,
    );
    const liveResume = spawnSync(process.execPath, [adapterPath, "checkpoint", resumeSkew], {
      encoding: "utf8",
    });
    assert.equal(liveResume.status, 0, liveResume.stderr);
    assert.deepInclude(JSON.parse(liveResume.stdout), {
      report: "progress",
      process_alive: true,
      blocker: null,
    });
    writeFileSync(
      path.join(resumeSkew, "pid.json"),
      `${JSON.stringify({ child_pid: 2_147_483_647 })}\n`,
    );
    const deadResume = spawnSync(process.execPath, [adapterPath, "checkpoint", resumeSkew], {
      encoding: "utf8",
    });
    assert.equal(deadResume.status, 0, deadResume.stderr);
    assert.deepInclude(JSON.parse(deadResume.stdout), {
      report: "blocked",
      process_alive: false,
    });
    const deadResumeWait = spawnSync(process.execPath, [adapterPath, "wait", resumeSkew, "1"], {
      encoding: "utf8",
    });
    assert.equal(deadResumeWait.status, 1, deadResumeWait.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
