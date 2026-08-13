import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { STUDY_BUDDY_DELIVERABLES_DIRECTORY } from "@t3tools/shared/studyBuddyWorkspace";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ProjectDeletedEvent = Extract<OrchestrationEvent, { type: "project.deleted" }>;
type WorkspaceCleanupEvent = ThreadDeletedEvent | ProjectDeletedEvent;

export function hasOnlyEmptyQuickChatDeliverables(input: {
  readonly workspaceEntries: readonly string[];
  readonly deliverablesEntries: readonly string[];
}): boolean {
  return (
    (input.workspaceEntries.length === 0 ||
      (input.workspaceEntries.length === 1 &&
        input.workspaceEntries[0] === STUDY_BUDDY_DELIVERABLES_DIRECTORY)) &&
    input.deliverablesEntries.length === 0
  );
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const logCleanupWarningCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logWarning(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const isSafeQuickChatWorkspacePath = (targetWorkspaceRoot: string): boolean => {
    const quickChatsRoot = path.resolve(serverConfig.quickChatWorkspaceRoot);
    const targetPath = path.resolve(targetWorkspaceRoot);
    const relativeTarget = path.relative(quickChatsRoot, targetPath);

    return (
      targetPath !== quickChatsRoot &&
      relativeTarget.length > 0 &&
      relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeTarget)
    );
  };

  const isDisposableUnpromptedQuickChatWorkspace = Effect.fn(
    "isDisposableUnpromptedQuickChatWorkspace",
  )(function* (targetWorkspaceRoot: string) {
    const workspaceExists = yield* fileSystem
      .exists(targetWorkspaceRoot)
      .pipe(Effect.orElseSucceed(() => false));
    if (!workspaceExists) {
      return true;
    }
    const workspaceEntries = yield* fileSystem.readDirectory(targetWorkspaceRoot, {
      recursive: false,
    });
    if (workspaceEntries.length === 0) {
      return true;
    }
    if (
      workspaceEntries.length !== 1 ||
      workspaceEntries[0] !== STUDY_BUDDY_DELIVERABLES_DIRECTORY
    ) {
      return false;
    }
    const deliverablesRoot = path.join(targetWorkspaceRoot, STUDY_BUDDY_DELIVERABLES_DIRECTORY);
    const deliverablesStat = yield* fileSystem.stat(deliverablesRoot);
    if (deliverablesStat.type !== "Directory") {
      return false;
    }
    const deliverablesEntries = yield* fileSystem.readDirectory(deliverablesRoot, {
      recursive: false,
    });
    return hasOnlyEmptyQuickChatDeliverables({ workspaceEntries, deliverablesEntries });
  });

  const deleteQuickChatProject = Effect.fn("deleteQuickChatProject")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { projectId } = event.payload;
    if (projectId === undefined) {
      return;
    }
    const commandId = CommandId.make(yield* crypto.randomUUIDv4);
    yield* orchestrationEngine.dispatch({
      type: "project.delete",
      commandId,
      projectId,
      force: true,
    });
  });

  const removeQuickChatWorkspace = Effect.fn("removeQuickChatWorkspace")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { projectWorkspaceRoot, threadId } = event.payload;
    if (projectWorkspaceRoot === undefined) {
      return;
    }
    if (!isSafeQuickChatWorkspacePath(projectWorkspaceRoot)) {
      yield* Effect.logWarning("skipping unsafe quick chat workspace cleanup", {
        threadId,
        projectWorkspaceRoot,
        quickChatWorkspaceRoot: serverConfig.quickChatWorkspaceRoot,
      });
      return;
    }
    yield* fileSystem.remove(projectWorkspaceRoot, { recursive: true, force: true });
  });

  const removeUnpromptedQuickChatWorkspace = Effect.fn("removeUnpromptedQuickChatWorkspace")(
    function* (event: ProjectDeletedEvent) {
      const { projectWorkspaceRoot } = event.payload;
      if (
        event.payload.projectKind !== "quick-chat" ||
        projectWorkspaceRoot === undefined ||
        !isSafeQuickChatWorkspacePath(projectWorkspaceRoot)
      ) {
        return;
      }
      if (!(yield* isDisposableUnpromptedQuickChatWorkspace(projectWorkspaceRoot))) {
        yield* Effect.logInfo("preserving non-empty unprompted quick chat workspace", {
          projectId: event.payload.projectId,
          projectWorkspaceRoot,
        });
        return;
      }
      yield* fileSystem.remove(projectWorkspaceRoot, { recursive: true, force: true });
    },
  );

  const cleanupQuickChat = Effect.fn("cleanupQuickChat")(function* (event: ThreadDeletedEvent) {
    if (
      event.payload.projectKind !== "quick-chat" ||
      event.payload.projectId === undefined ||
      event.payload.projectWorkspaceRoot === undefined
    ) {
      return;
    }

    yield* logCleanupWarningCauseUnlessInterrupted({
      effect: deleteQuickChatProject(event),
      message: "quick chat cleanup skipped project deletion",
      threadId: event.payload.threadId,
    });
    yield* logCleanupWarningCauseUnlessInterrupted({
      effect: removeQuickChatWorkspace(event),
      message: "quick chat cleanup skipped workspace deletion",
      threadId: event.payload.threadId,
    });
  });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* cleanupQuickChat(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processWorkspaceCleanupEventSafely = (event: WorkspaceCleanupEvent) => {
    if (event.type === "thread.deleted") {
      return processThreadDeletedSafely(event);
    }
    return removeUnpromptedQuickChatWorkspace(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("project deletion cleanup failed to process event", {
          eventType: event.type,
          projectId: event.payload.projectId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  };

  const worker = yield* makeDrainableWorker(processWorkspaceCleanupEventSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted" && event.type !== "project.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
