import { assert, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectRunContract } from "./study-buddy-packaged-task.mjs";

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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("fails closed on an ownerless packaged artifact lock", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "study-buddy-packaged-lock-"));
  const workspace = path.join(temp, "workspace");
  const packagedRoot = path.join(temp, "root");
  const lockDir = path.join(workspace, "study-buddy-data", "locks", ".artifact-workflow.lock");
  const adapterPath = fileURLToPath(new URL("./study-buddy-packaged-task.mjs", import.meta.url));
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
