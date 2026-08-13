import type { ProjectKind } from "@t3tools/contracts";

export const STUDY_BUDDY_DELIVERABLES_DIRECTORY = "study-buddy-deliverables";

export function joinWorkspacePath(basePath: string, ...segments: readonly string[]): string {
  const trimmedBase = basePath.replace(/[\\/]+$/, "");
  const separator = trimmedBase.includes("\\") && !trimmedBase.includes("/") ? "\\" : "/";
  const normalizedSegments = segments
    .map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter((segment) => segment.length > 0);
  return [trimmedBase, ...normalizedSegments]
    .filter((segment) => segment.length > 0)
    .join(separator);
}

export function resolveStudyBuddyOpenPath(input: {
  readonly cwd: string | null;
  readonly projectKind: ProjectKind | undefined;
}): string | null {
  if (!input.cwd || input.projectKind !== "quick-chat") {
    return input.cwd;
  }
  return joinWorkspacePath(input.cwd, STUDY_BUDDY_DELIVERABLES_DIRECTORY);
}

export function hasUserAuthoredDraftContent(
  draft:
    | {
        readonly prompt: string;
        readonly images: readonly unknown[];
        readonly persistedAttachments: readonly unknown[];
        readonly terminalContexts: readonly unknown[];
      }
    | null
    | undefined,
): boolean {
  return Boolean(
    draft &&
    (draft.prompt.trim().length > 0 ||
      draft.images.length > 0 ||
      draft.persistedAttachments.length > 0 ||
      draft.terminalContexts.length > 0),
  );
}

export function shouldCleanupUnpromptedQuickChat(input: {
  readonly threadCount: number;
  readonly hasDraftReservation: boolean;
  readonly isSubmitting: boolean;
  readonly draft: Parameters<typeof hasUserAuthoredDraftContent>[0];
}): boolean {
  return (
    input.hasDraftReservation &&
    !input.isSubmitting &&
    input.threadCount === 0 &&
    !hasUserAuthoredDraftContent(input.draft)
  );
}
