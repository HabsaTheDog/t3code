import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import {
  hasOnlyEmptyQuickChatDeliverables,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("unprompted Quick Chat workspace cleanup", () => {
  it("allows removal only when the workspace contains no user files", () => {
    expect(
      hasOnlyEmptyQuickChatDeliverables({ workspaceEntries: [], deliverablesEntries: [] }),
    ).toBe(true);
    expect(
      hasOnlyEmptyQuickChatDeliverables({
        workspaceEntries: ["study-buddy-deliverables"],
        deliverablesEntries: [],
      }),
    ).toBe(true);
    expect(
      hasOnlyEmptyQuickChatDeliverables({
        workspaceEntries: ["study-buddy-deliverables"],
        deliverablesEntries: ["notes.pdf"],
      }),
    ).toBe(false);
    expect(
      hasOnlyEmptyQuickChatDeliverables({
        workspaceEntries: ["study-buddy-data", "study-buddy-deliverables"],
        deliverablesEntries: [],
      }),
    ).toBe(false);
  });
});
