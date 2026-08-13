import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const creatingByEnvironment = new Set<EnvironmentId>();
const submittingProjects = new Map<string, number>();

const projectKey = (environmentId: EnvironmentId, projectId: ProjectId): string =>
  `${environmentId}:${projectId}`;

export function acquireQuickChatCreation(environmentId: EnvironmentId): boolean {
  if (creatingByEnvironment.has(environmentId)) return false;
  creatingByEnvironment.add(environmentId);
  return true;
}

export function releaseQuickChatCreation(environmentId: EnvironmentId): void {
  creatingByEnvironment.delete(environmentId);
}

export function markQuickChatSubmitting(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): () => void {
  const key = projectKey(environmentId, projectId);
  submittingProjects.set(key, (submittingProjects.get(key) ?? 0) + 1);
  return () => {
    const remaining = (submittingProjects.get(key) ?? 1) - 1;
    if (remaining <= 0) submittingProjects.delete(key);
    else submittingProjects.set(key, remaining);
  };
}

export function isQuickChatSubmitting(environmentId: EnvironmentId, projectId: ProjectId): boolean {
  return (submittingProjects.get(projectKey(environmentId, projectId)) ?? 0) > 0;
}

export function resetQuickChatLifecycleForTests(): void {
  creatingByEnvironment.clear();
  submittingProjects.clear();
}
