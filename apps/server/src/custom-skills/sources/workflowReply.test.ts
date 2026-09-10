// @effect-diagnostics nodeBuiltinImport:off -- Exercises the filesystem handoff boundary.
// @effect-diagnostics globalDate:off -- Freshness is a wall-clock validation boundary.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { bindWorkflowReply, saveWorkflowReply, readWorkflowReply } from "./workflowReply.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(status = "answered") {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "workflow-reply-"));
  directories.push(workspace);
  const source = path.join(workspace, "study-buddy-data", "runs", "answer.json");
  await mkdir(path.dirname(source), { recursive: true });
  const answer = {
    schemaVersion: 1,
    kind: "quick_answer",
    prompt: "Alle Fristen bis morgen",
    answer: "Frist 23:45.\nUnbekannt: [Aufgabe](https://example.org/task).",
    status,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(source, JSON.stringify(answer));
  await writeFile(path.join(path.dirname(source), "answer.md"), answer.answer + "\n");
  return {
    workspace,
    stateDir: path.join(workspace, "state"),
    startedAt: Date.now() - 10_000,
    binding: { threadId: "thread-1", turnId: "turn-1", prompt: answer.prompt },
    result: { exitCode: 0, stdout: `Wrote answer data: ${source}\n`, stderr: "" },
    source,
    answer,
  };
}

describe("canonical workflow reply", () => {
  it.each(["answered", "partial"])(
    "preserves exact %s text for only the bound turn",
    async (status) => {
      const f = await fixture(status);
      expect(await saveWorkflowReply(f)).toBe(true);
      expect(await readWorkflowReply(f.stateDir, "thread-1", "turn-1")).toBe(f.answer.answer);
      expect(await readWorkflowReply(f.stateDir, "thread-2", "turn-1")).toBeNull();
      expect(await readWorkflowReply(f.stateDir, "thread-1", "turn-2")).toBeNull();
    },
  );
  it("rejects unsuccessful, stale, mismatched and ambiguous results", async () => {
    const f = await fixture();
    expect(await saveWorkflowReply({ ...f, result: { ...f.result, exitCode: 1 } })).toBe(false);
    expect(await saveWorkflowReply({ ...f, startedAt: Date.now() + 10_000 })).toBe(false);
    expect(await saveWorkflowReply({ ...f, binding: { ...f.binding, prompt: "different" } })).toBe(
      false,
    );
    expect(
      await saveWorkflowReply({ ...f, result: { ...f.result, stdout: f.result.stdout.repeat(2) } }),
    ).toBe(false);
    expect(await readWorkflowReply(f.stateDir, "thread-1", "turn-1")).toBeNull();
  });
  it("rejects a source outside the workspace, including a symlink", async () => {
    const f = await fixture();
    const outside = await fixture();
    await rm(f.source);
    await symlink(outside.source, f.source);
    expect(await saveWorkflowReply(f)).toBe(false);
  });
  it("rejects a markdown sibling redirected outside the run directory", async () => {
    const f = await fixture();
    const outside = await fixture();
    const markdown = path.join(path.dirname(f.source), "answer.md");
    await rm(markdown);
    await symlink(path.join(path.dirname(outside.source), "answer.md"), markdown);
    expect(await saveWorkflowReply(f)).toBe(false);
  });
  it("rejects inconsistent markdown and invalid terminal schemas", async () => {
    const f = await fixture();
    await writeFile(path.join(path.dirname(f.source), "answer.md"), "different");
    expect(await saveWorkflowReply(f)).toBe(false);
    await writeFile(path.join(path.dirname(f.source), "answer.md"), f.answer.answer);
    await writeFile(
      f.source,
      (await readFile(f.source, "utf8")).replace('"answered"', '"not_found"'),
    );
    expect(await saveWorkflowReply(f)).toBe(false);
  });
});

describe("workflow reply binding", () => {
  it("requires the current prompt, thread, workspace and one active turn", () => {
    const thread = {
      id: "thread-1",
      projectId: "project-1",
      deletedAt: null,
      worktreePath: "/workspace",
      session: { status: "running", activeTurnId: "turn-1" },
      messages: [{ role: "user", text: "Alle Fristen" }],
    };
    const snapshot = { threads: [thread], projects: [] } as unknown as OrchestrationReadModel;
    const request = {
      args: ["prompt", "Alle Fristen"],
      workspace: "/workspace",
      threadId: "thread-1",
    };
    expect(bindWorkflowReply(snapshot, request, "/workspace")).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      prompt: "Alle Fristen",
    });
    expect(
      bindWorkflowReply(snapshot, { ...request, threadId: "other-thread" }, "/workspace"),
    ).toBeNull();
    expect(
      bindWorkflowReply(
        snapshot,
        { ...request, args: ["prompt", "Different prompt"] },
        "/workspace",
      ),
    ).toBeNull();
    expect(bindWorkflowReply(snapshot, request, "/other-workspace")).toBeNull();
    expect(
      bindWorkflowReply(
        { ...snapshot, threads: [...snapshot.threads, ...snapshot.threads] },
        request,
        "/workspace",
      ),
    ).toBeNull();
    thread.session.status = "ready";
    expect(bindWorkflowReply(snapshot, request, "/workspace")).toBeNull();
  });
});
