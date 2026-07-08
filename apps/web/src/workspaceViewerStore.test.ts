import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWER_CHAT_WIDTH,
  selectThreadViewerState,
  useWorkspaceViewerStore,
} from "./workspaceViewerStore";

const environmentId = EnvironmentId.make("environment-a");
const firstThread = {
  environmentId,
  threadId: ThreadId.make("thread-a"),
};
const secondThread = {
  environmentId,
  threadId: ThreadId.make("thread-b"),
};

describe("workspaceViewerStore", () => {
  beforeEach(() => {
    useWorkspaceViewerStore.setState({
      viewerStateByThreadKey: {},
      chatWidth: DEFAULT_VIEWER_CHAT_WIDTH,
    });
  });

  it("keeps tabs and active selection isolated per thread", () => {
    const store = useWorkspaceViewerStore.getState();
    store.openTab(firstThread, {
      kind: "plan",
      environmentId,
      threadId: firstThread.threadId,
    });
    store.openTab(firstThread, {
      kind: "diff",
      environmentId,
      threadId: firstThread.threadId,
      turnId: TurnId.make("turn-1"),
    });
    store.openTab(secondThread, {
      kind: "website",
      url: "https://example.com",
    });

    const state = useWorkspaceViewerStore.getState().viewerStateByThreadKey;
    const first = selectThreadViewerState(state, firstThread);
    const second = selectThreadViewerState(state, secondThread);

    expect(first.tabs.map((tab) => tab.source.kind)).toEqual(["plan", "diff"]);
    expect(first.activeTabId).toContain("diff:");
    expect(second.tabs.map((tab) => tab.source.kind)).toEqual(["website"]);
  });

  it("activates the nearest remaining tab and collapses after the last close", () => {
    const store = useWorkspaceViewerStore.getState();
    store.openTab(firstThread, {
      kind: "plan",
      environmentId,
      threadId: firstThread.threadId,
    });
    store.openTab(firstThread, {
      kind: "website",
      url: "https://example.com",
    });

    let viewer = selectThreadViewerState(
      useWorkspaceViewerStore.getState().viewerStateByThreadKey,
      firstThread,
    );
    store.closeTab(firstThread, viewer.activeTabId!);
    viewer = selectThreadViewerState(
      useWorkspaceViewerStore.getState().viewerStateByThreadKey,
      firstThread,
    );
    expect(viewer.activeTabId).toBe("plan");

    store.closeTab(firstThread, "plan");
    viewer = selectThreadViewerState(
      useWorkspaceViewerStore.getState().viewerStateByThreadKey,
      firstThread,
    );
    expect(viewer).toMatchObject({ tabs: [], activeTabId: null });
  });

  it("deduplicates the same source while retaining distinct diff selections", () => {
    const store = useWorkspaceViewerStore.getState();
    const baseDiff = {
      kind: "diff" as const,
      environmentId,
      threadId: firstThread.threadId,
      turnId: TurnId.make("turn-1"),
    };
    store.openTab(firstThread, baseDiff);
    store.openTab(firstThread, baseDiff);
    store.openTab(firstThread, { ...baseDiff, filePath: "src/app.ts" });

    const viewer = selectThreadViewerState(
      useWorkspaceViewerStore.getState().viewerStateByThreadKey,
      firstThread,
    );
    expect(viewer.tabs).toHaveLength(2);
  });
});
