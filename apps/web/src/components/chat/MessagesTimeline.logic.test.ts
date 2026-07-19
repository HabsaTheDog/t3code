import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapTopPercent,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
    expect(rows.some((row) => row.kind === "turn-fold" && row.expanded)).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:20Z",
        completedAt: null,
      },
      runningTurnId: "turn-2" as never,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("creates independent collapsed folds for completed exchanges", () => {
    const timelineEntries = [
      messageEntry("user-1", "user", "First question", null, "2026-01-01T00:00:00Z"),
      workEntry("work-1", "turn-1", "2026-01-01T00:00:04Z"),
      messageEntry(
        "assistant-1",
        "assistant",
        "First answer",
        "turn-1",
        "2026-01-01T00:00:10Z",
        "2026-01-01T00:00:12Z",
      ),
      messageEntry("user-2", "user", "Second question", null, "2026-01-01T00:01:00Z"),
      workEntry("work-2", "turn-2", "2026-01-01T00:01:03Z"),
      messageEntry(
        "assistant-2",
        "assistant",
        "Second answer",
        "turn-2",
        "2026-01-01T00:01:07Z",
        "2026-01-01T00:01:09Z",
      ),
    ];

    const collapsed = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(collapsed.map((row) => row.id)).toEqual([
      "user-1",
      "turn-fold:turn-1",
      "assistant-1",
      "user-2",
      "turn-fold:turn-2",
      "assistant-2",
    ]);
    expect(collapsed.filter((row) => row.kind === "turn-fold").map((row) => row.label)).toEqual([
      "Worked for 12s",
      "Worked for 9.0s",
    ]);

    const firstExpanded = deriveMessagesTimelineRows({
      timelineEntries,
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(firstExpanded.map((row) => row.id)).toEqual([
      "user-1",
      "turn-fold:turn-1",
      "work-1",
      "assistant-1",
      "user-2",
      "turn-fold:turn-2",
      "assistant-2",
    ]);
  });

  it("keeps active and unkeyed activity visible while folding prior turns", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        workEntry("old-work", "turn-1", "2026-01-01T00:00:03Z"),
        messageEntry(
          "old-answer",
          "assistant",
          "Done",
          "turn-1",
          "2026-01-01T00:00:05Z",
          "2026-01-01T00:00:06Z",
        ),
        messageEntry("user-2", "user", "Continue", null, "2026-01-01T00:01:00Z"),
        workEntry("active-work", "turn-2", "2026-01-01T00:01:02Z"),
        workEntry("unkeyed-work", null, "2026-01-01T00:01:03Z"),
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "old-answer",
      "user-2",
      "active-work",
      "working-indicator-row",
    ]);
    const activeWork = rows.find((row) => row.id === "active-work");
    expect(activeWork?.kind).toBe("work");
    expect(
      activeWork?.kind === "work" ? activeWork.groupedEntries.map((entry) => entry.id) : [],
    ).toEqual(["active-work", "unkeyed-work"]);
  });

  it("uses interrupted wording and tolerates malformed timestamps", () => {
    const interrupted = deriveMessagesTimelineRows({
      timelineEntries: [workEntry("work-1", "turn-1", "not-a-date")],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "not-a-date",
        completedAt: "also-not-a-date",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(interrupted[0]).toMatchObject({
      kind: "turn-fold",
      label: "You stopped this response",
    });
  });
});

describe("timeline minimap geometry", () => {
  it("maps items and pointer positions across the enlarged rail", () => {
    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(48px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 5,
        railTop: 100,
        railHeight: 400,
        pointerY: 300,
      }),
    ).toBe(2);
  });

  it("requires enough side gutter before remaining persistently visible", () => {
    expect(resolveTimelineMinimapHasPersistentGutter(895)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(896)).toBe(true);
  });
});

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null,
  createdAt: string,
  completedAt?: string,
) {
  return {
    id,
    kind: "message" as const,
    createdAt,
    message: {
      id: id as never,
      role,
      text,
      turnId: turnId as never,
      createdAt,
      ...(completedAt ? { completedAt } : {}),
      streaming: false,
    },
  };
}

function workEntry(id: string, turnId: string | null, createdAt: string) {
  return {
    id,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      createdAt,
      turnId: turnId as never,
      label: `Work ${id}`,
      tone: "tool" as const,
    },
  };
}

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
