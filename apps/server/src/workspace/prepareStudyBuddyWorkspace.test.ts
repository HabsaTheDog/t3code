import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "./Layers/WorkspacePaths.ts";
import {
  prepareOpenInWorkspace,
  prepareStudyBuddyWorkspace,
} from "./prepareStudyBuddyWorkspace.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "study-buddy-workspace-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("prepareStudyBuddyWorkspace", (it) => {
  it.effect("keeps concurrent Quick Chat outputs in separate app-owned workspaces", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoots = [
        path.join(config.quickChatWorkspaceRoot, "thread-parallel-a"),
        path.join(config.quickChatWorkspaceRoot, "thread-parallel-b"),
      ] as const;

      const preparedRoots = yield* Effect.all(
        workspaceRoots.map((workspaceRoot) =>
          prepareStudyBuddyWorkspace({
            workspaceRoot,
            projectKind: "quick-chat",
            operation: "send",
          }),
        ),
        { concurrency: "unbounded" },
      );

      expect(preparedRoots).toEqual(workspaceRoots);
      expect(preparedRoots[0]).not.toBe(preparedRoots[1]);
      for (const workspaceRoot of preparedRoots) {
        expect(
          (yield* fileSystem.stat(path.join(workspaceRoot, "study-buddy-deliverables"))).type,
        ).toBe("Directory");
      }
    }),
  );

  it.effect("recreates an app-owned Quick Chat root and deliverables before send", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = path.join(config.quickChatWorkspaceRoot, "thread-safe-repair");

      const prepared = yield* prepareStudyBuddyWorkspace({
        workspaceRoot,
        projectKind: "quick-chat",
        operation: "send",
      });

      expect(prepared).toBe(workspaceRoot);
      expect((yield* fileSystem.stat(workspaceRoot)).type).toBe("Directory");
      expect(
        (yield* fileSystem.stat(path.join(workspaceRoot, "study-buddy-deliverables"))).type,
      ).toBe("Directory");
    }),
  );

  it.effect("recreates deliverables and returns it as the Quick Chat Open target", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = path.join(config.quickChatWorkspaceRoot, "thread-open-repair");
      const deliverablesRoot = path.join(workspaceRoot, "study-buddy-deliverables");

      const target = yield* prepareOpenInWorkspace({
        cwd: deliverablesRoot,
        projectKind: "quick-chat",
      });

      expect(target).toBe(deliverablesRoot);
      expect((yield* fileSystem.stat(deliverablesRoot)).type).toBe("Directory");
    }),
  );

  it.effect("refuses to create a Quick Chat path outside the configured root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "outside-quick-chats-",
      });
      const unsafeRoot = `${outsideRoot}-must-not-exist`;

      const result = yield* Effect.exit(
        prepareStudyBuddyWorkspace({
          workspaceRoot: unsafeRoot,
          projectKind: "quick-chat",
          operation: "send",
        }),
      );

      expect(result._tag).toBe("Failure");
      expect(yield* fileSystem.exists(unsafeRoot)).toBe(false);
    }),
  );

  it.effect("reports a missing regular project without recreating it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const missingRoot = `${yield* fileSystem.makeTempDirectoryScoped({
        prefix: "missing-regular-project-",
      })}-must-not-exist`;

      const result = yield* Effect.exit(
        prepareStudyBuddyWorkspace({
          workspaceRoot: missingRoot,
          projectKind: "regular",
          operation: "open",
        }),
      );

      expect(result._tag).toBe("Failure");
      expect(yield* fileSystem.exists(missingRoot)).toBe(false);
      expect(String(result)).toContain("remove and re-add the project");
    }),
  );
});
