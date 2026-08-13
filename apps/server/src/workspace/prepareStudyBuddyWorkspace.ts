import type { ProjectKind } from "@t3tools/contracts";
import { STUDY_BUDDY_DELIVERABLES_DIRECTORY } from "@t3tools/shared/studyBuddyWorkspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { WorkspacePaths } from "./Services/WorkspacePaths.ts";

export type WorkspaceOperation = "open" | "send";

export class StudyBuddyWorkspacePreparationError extends Schema.TaggedErrorClass<StudyBuddyWorkspacePreparationError>()(
  "StudyBuddyWorkspacePreparationError",
  {
    workspaceRoot: Schema.String,
    projectKind: Schema.optional(Schema.Literals(["regular", "quick-chat"])),
    operation: Schema.Literals(["open", "send"]),
    message: Schema.String,
  },
) {}

const preparationError = (input: {
  readonly workspaceRoot: string;
  readonly projectKind: ProjectKind | undefined;
  readonly operation: WorkspaceOperation;
  readonly message: string;
}) => new StudyBuddyWorkspacePreparationError(input);

export const prepareStudyBuddyWorkspace = Effect.fn("prepareStudyBuddyWorkspace")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly projectKind: ProjectKind | undefined;
    readonly operation: WorkspaceOperation;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;
    const logFailure = (error: StudyBuddyWorkspacePreparationError) =>
      Effect.logWarning("study buddy workspace preparation failed", {
        operation: error.operation,
        projectKind: error.projectKind ?? "regular",
        workspaceRoot: error.workspaceRoot,
        recovery:
          error.projectKind === "quick-chat"
            ? "check-permissions-or-create-new-quick-chat"
            : "restore-or-readd-project",
      });

    if (input.projectKind !== "quick-chat") {
      return yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(() =>
          preparationError({
            ...input,
            message: `Project workspace is unavailable at '${input.workspaceRoot}'. Restore or move it back to this path, or remove and re-add the project using its current folder.`,
          }),
        ),
        Effect.tapError(logFailure),
      );
    }

    const configuredRoot = path.resolve(serverConfig.quickChatWorkspaceRoot);
    const requestedRoot = path.resolve(input.workspaceRoot);
    const relativeRoot = path.relative(configuredRoot, requestedRoot);
    const isCanonicalDirectChild =
      relativeRoot.length > 0 &&
      relativeRoot !== "." &&
      !path.isAbsolute(relativeRoot) &&
      path.dirname(relativeRoot) === ".";
    if (!isCanonicalDirectChild) {
      const error = preparationError({
        ...input,
        message: `Quick Chat workspace repair was refused because '${input.workspaceRoot}' is outside the configured Quick Chats directory. Create a new Quick Chat or restore the original app-owned folder.`,
      });
      yield* Effect.logWarning("study buddy workspace preparation refused", {
        operation: error.operation,
        projectKind: "quick-chat",
        workspaceRoot: error.workspaceRoot,
        configuredQuickChatsRoot: configuredRoot,
        recovery: "create-new-quick-chat-or-restore",
      });
      return yield* error;
    }

    const workspaceWasMissing = yield* fileSystem.stat(requestedRoot).pipe(
      Effect.as(false),
      Effect.orElseSucceed(() => true),
    );
    const deliverablesRoot = path.join(requestedRoot, STUDY_BUDDY_DELIVERABLES_DIRECTORY);
    const deliverablesWereMissing = yield* fileSystem.stat(deliverablesRoot).pipe(
      Effect.as(false),
      Effect.orElseSucceed(() => true),
    );

    const normalizedRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(requestedRoot, { createIfMissing: true })
      .pipe(
        Effect.mapError(() =>
          preparationError({
            ...input,
            message: `Quick Chat workspace could not be restored at '${requestedRoot}'. Check directory permissions and try again.`,
          }),
        ),
        Effect.tapError(logFailure),
      );
    yield* fileSystem.makeDirectory(deliverablesRoot, { recursive: true }).pipe(
      Effect.mapError(() =>
        preparationError({
          ...input,
          message: `Quick Chat deliverables could not be restored at '${deliverablesRoot}'. Check directory permissions and try again.`,
        }),
      ),
      Effect.tapError(logFailure),
    );

    if (workspaceWasMissing || deliverablesWereMissing) {
      yield* Effect.logInfo("study buddy quick chat workspace repaired", {
        operation: input.operation,
        projectKind: "quick-chat",
        workspaceRoot: normalizedRoot,
        deliverablesRoot,
        workspaceWasMissing,
        deliverablesWereMissing,
      });
    }
    return normalizedRoot;
  },
);

export const prepareOpenInWorkspace = Effect.fn("prepareOpenInWorkspace")(function* (input: {
  readonly cwd: string;
  readonly projectKind: ProjectKind;
}) {
  const path = yield* Path.Path;
  if (input.projectKind !== "quick-chat") {
    return yield* prepareStudyBuddyWorkspace({
      workspaceRoot: input.cwd,
      projectKind: input.projectKind,
      operation: "open",
    });
  }

  const workspaceRoot = path.dirname(input.cwd);
  const expectedDeliverablesRoot = path.join(workspaceRoot, STUDY_BUDDY_DELIVERABLES_DIRECTORY);
  if (path.resolve(input.cwd) !== path.resolve(expectedDeliverablesRoot)) {
    const error = preparationError({
      workspaceRoot,
      projectKind: "quick-chat",
      operation: "open",
      message: `Quick Chat Open must target its '${STUDY_BUDDY_DELIVERABLES_DIRECTORY}' directory.`,
    });
    yield* Effect.logWarning("study buddy workspace preparation refused", {
      operation: error.operation,
      projectKind: "quick-chat",
      workspaceRoot: error.workspaceRoot,
      requestedOpenTarget: input.cwd,
      recovery: "open-canonical-deliverables",
    });
    return yield* error;
  }
  const normalizedRoot = yield* prepareStudyBuddyWorkspace({
    workspaceRoot,
    projectKind: "quick-chat",
    operation: "open",
  });
  return path.join(normalizedRoot, STUDY_BUDDY_DELIVERABLES_DIRECTORY);
});
