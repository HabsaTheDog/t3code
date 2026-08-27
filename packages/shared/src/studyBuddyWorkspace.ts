import type { ProjectKind } from "@t3tools/contracts";

export const STUDY_BUDDY_DELIVERABLES_DIRECTORY = "study-buddy-deliverables";

function trimPathSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === "/" || value[start] === "\\")) start += 1;
  while (end > start && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(start, end);
}

function trimTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

export function joinWorkspacePath(basePath: string, ...segments: readonly string[]): string {
  const trimmedBase = trimTrailingPathSeparators(basePath);
  const separator = trimmedBase.includes("\\") && !trimmedBase.includes("/") ? "\\" : "/";
  const normalizedSegments = segments
    .map(trimPathSeparators)
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
