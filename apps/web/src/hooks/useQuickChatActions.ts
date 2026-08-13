import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newDraftId, newProjectId, newThreadId } from "../lib/utils";
import { useServerConfig } from "../rpc/serverState";
import {
  selectProjectByRef,
  selectProjectsForEnvironment,
  selectThreadIdsByProjectRef,
  useStore,
} from "../store";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  joinWorkspacePath,
  shouldCleanupUnpromptedQuickChat,
} from "@t3tools/shared/studyBuddyWorkspace";
import {
  acquireQuickChatCreation,
  isQuickChatSubmitting,
  releaseQuickChatCreation,
} from "../quickChatLifecycle";

async function waitForProjectInStore(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  timeoutMs?: number;
}): Promise<void> {
  const projectRef = scopeProjectRef(input.environmentId, input.projectId);
  if (selectProjectByRef(useStore.getState(), projectRef)) {
    return;
  }

  await new Promise<void>((resolve) => {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe = () => {};
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve();
    };
    unsubscribe = useStore.subscribe((state) => {
      if (selectProjectByRef(state, projectRef)) {
        finish();
      }
    });
    timeoutId = globalThis.setTimeout(finish, input.timeoutMs ?? 1_000);
  });
}

export function useQuickChatActions() {
  const navigate = useNavigate();
  const [isCreatingQuickChat, setIsCreatingQuickChat] = useState(false);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const targetEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const primaryServerConfig = useServerConfig();
  const targetRuntimeServerConfig = useSavedEnvironmentRuntimeStore((state) =>
    targetEnvironmentId ? (state.byId[targetEnvironmentId]?.serverConfig ?? null) : null,
  );
  const serverConfig =
    targetEnvironmentId === primaryEnvironmentId
      ? (primaryServerConfig ?? targetRuntimeServerConfig)
      : (targetRuntimeServerConfig ?? primaryServerConfig);

  const createQuickChat = useCallback(async () => {
    if (!targetEnvironmentId || !serverConfig) {
      throw new Error("No connected environment is available for Quick Chat.");
    }
    const api = readEnvironmentApi(targetEnvironmentId);
    if (!api) {
      throw new Error("Quick Chat environment API is unavailable.");
    }
    if (!acquireQuickChatCreation(targetEnvironmentId)) {
      return;
    }
    setIsCreatingQuickChat(true);

    try {
      const appState = useStore.getState();
      const draftStore = useComposerDraftStore.getState();
      const abandonedQuickChatProjects = selectProjectsForEnvironment(appState, targetEnvironmentId)
        .filter((project) => project.projectKind === "quick-chat")
        .filter((project) => {
          const projectRef = scopeProjectRef(targetEnvironmentId, project.id);
          const draftSession = draftStore.getDraftSessionByProjectRef(projectRef);
          const draft = draftSession ? draftStore.getComposerDraft(draftSession.draftId) : null;
          return shouldCleanupUnpromptedQuickChat({
            threadCount: selectThreadIdsByProjectRef(appState, projectRef).length,
            hasDraftReservation: draftSession !== null,
            isSubmitting: isQuickChatSubmitting(targetEnvironmentId, project.id),
            draft,
          });
        });

      for (const project of abandonedQuickChatProjects) {
        await api.orchestration
          .dispatchCommand({
            type: "project.delete",
            commandId: newCommandId(),
            projectId: project.id,
          })
          .catch((error: unknown) => {
            console.warn("Quick Chat cleanup was refused; preserving the existing project.", {
              projectId: project.id,
              error,
            });
          });
      }

      const projectId = newProjectId();
      const threadId = newThreadId();
      const draftId = newDraftId();
      const createdAt = new Date().toISOString();
      const workspaceRoot = joinWorkspacePath(serverConfig.quickChatWorkspaceRoot, threadId);
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };

      await api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        projectKind: "quick-chat",
        title: "Quick Chat",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: modelSelection,
        createdAt,
      });
      await waitForProjectInStore({
        environmentId: targetEnvironmentId,
        projectId,
      });

      const projectRef = scopeProjectRef(targetEnvironmentId, projectId);
      useComposerDraftStore
        .getState()
        .setLogicalProjectDraftThreadId(
          `quick-chat:${targetEnvironmentId}:${threadId}`,
          projectRef,
          draftId,
          {
            threadId,
            createdAt,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        );
      useComposerDraftStore.getState().applyStickyState(draftId);

      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
      });
    } finally {
      releaseQuickChatCreation(targetEnvironmentId);
      setIsCreatingQuickChat(false);
    }
  }, [navigate, serverConfig, targetEnvironmentId]);

  return {
    createQuickChat,
    isCreatingQuickChat,
  };
}
