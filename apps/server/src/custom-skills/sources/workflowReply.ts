// @effect-diagnostics nodeBuiltinImport:off -- Server-owned canonical workflow result handoff.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import type { StudyBuddyWorkflowRequest, StudyBuddyWorkflowResult } from "./workflowBroker.ts";

export interface WorkflowReplyBinding {
  threadId: string;
  turnId: string;
  prompt: string;
}

/** Bind only an unambiguous active turn in the already-authorized workspace. */
export function bindWorkflowReply(
  snapshot: OrchestrationReadModel,
  request: StudyBuddyWorkflowRequest,
  workspace: string,
): WorkflowReplyBinding | null {
  const originalIndex = request.args.indexOf("--original-user-prompt");
  const prompt = originalIndex >= 0 ? request.args[originalIndex + 1] : request.args[1];
  if (!prompt) return null;
  const matches = snapshot.threads.filter((thread) => {
    const root =
      thread.worktreePath ??
      snapshot.projects.find((p) => p.id === thread.projectId)?.workspaceRoot;
    const latestUser = thread.messages.findLast((m) => m.role === "user");
    return (
      thread.deletedAt === null &&
      thread.session?.activeTurnId &&
      thread.session.status === "running" &&
      root &&
      path.resolve(root) === workspace &&
      latestUser?.text === prompt
    );
  });
  const thread = matches[0];
  if (matches.length !== 1 || !thread || request.threadId !== thread.id) return null;
  return { threadId: thread.id, turnId: thread.session!.activeTurnId!, prompt };
}

function replyPath(stateDir: string, threadId: string, turnId: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify([threadId, turnId]))
    .digest("hex");
  return path.join(stateDir, "study-buddy-data", "workflow-replies", `${key}.json`);
}

/** Read only a fresh terminal answer produced inside this invocation's workspace.
 * The broker owns the binding; neither a provider reply nor a source page can
 * select another turn or supply replacement response text through this API. */
export async function saveWorkflowReply(input: {
  stateDir: string;
  workspace: string;
  startedAt: number;
  binding: WorkflowReplyBinding;
  result: StudyBuddyWorkflowResult;
}): Promise<boolean> {
  if (input.result.exitCode !== 0) return false;
  const files = [...input.result.stdout.matchAll(/^Wrote answer data: (.+)$/gm)];
  if (files.length !== 1) return false;
  try {
    const source = await realpath(files[0]![1]!.trim());
    const root = await realpath(path.join(input.workspace, "study-buddy-data"));
    const relative = path.relative(root, source);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      path.basename(source) !== "answer.json"
    )
      return false;
    const info = await stat(source);
    if (!info.isFile() || info.size > 1024 * 1024 || info.mtimeMs < input.startedAt) return false;
    const answer = JSON.parse(await readFile(source, "utf8"));
    if (
      answer.schemaVersion !== 1 ||
      answer.kind !== "quick_answer" ||
      !["answered", "partial"].includes(answer.status) ||
      answer.prompt !== input.binding.prompt ||
      typeof answer.answer !== "string" ||
      !answer.answer.trim() ||
      !Number.isFinite(Date.parse(answer.generatedAt)) ||
      Date.parse(answer.generatedAt) < input.startedAt
    )
      return false;
    const markdownPath = await realpath(path.join(path.dirname(source), "answer.md"));
    if (path.dirname(markdownPath) !== path.dirname(source)) return false;
    const markdownInfo = await stat(markdownPath);
    if (!markdownInfo.isFile() || markdownInfo.size > 1024 * 1024) return false;
    const markdown = await readFile(markdownPath, "utf8");
    if (markdown.trim() !== answer.answer.trim()) return false;
    const target = replyPath(input.stateDir, input.binding.threadId, input.binding.turnId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, ...input.binding, text: answer.answer, status: answer.status }),
      { mode: 0o600 },
    );
    await rename(temporary, target);
    return true;
  } catch {
    return false;
  }
}

export async function readWorkflowReply(
  stateDir: string,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  try {
    const target = replyPath(stateDir, threadId, turnId);
    if ((await stat(target)).size > 1024 * 1024) return null;
    const reply = JSON.parse(await readFile(target, "utf8"));
    return reply.version === 1 &&
      reply.threadId === threadId &&
      reply.turnId === turnId &&
      ["answered", "partial"].includes(reply.status) &&
      typeof reply.text === "string" &&
      reply.text.trim()
      ? reply.text
      : null;
  } catch {
    return null;
  }
}
