import { describe, expect, it } from "vite-plus/test";

import { selectCompletedConversationTurns } from "./conversationSelection";

const timestamp = "2026-06-28T08:00:00.000Z";

describe("selectCompletedConversationTurns", () => {
  it("waits for terminal state and selects only the final assistant message", () => {
    const messages = [
      {
        role: "user",
        text: "Question",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
      },
      {
        role: "assistant",
        text: "Intermediate commentary",
        turnId: "turn-1",
        streaming: false,
        createdAt: timestamp,
      },
      {
        role: "assistant",
        text: "Final answer",
        turnId: "turn-1",
        streaming: false,
        createdAt: timestamp,
      },
    ];

    expect(
      selectCompletedConversationTurns(messages, { turnId: "turn-1", state: "running" }),
    ).toEqual([]);
    expect(
      selectCompletedConversationTurns(messages, {
        turnId: "turn-1",
        state: "completed",
        completedAt: timestamp,
      }),
    ).toMatchObject([
      {
        turnId: "turn-1",
        assistant: { text: "Final answer" },
        user: { text: "Question" },
      },
    ]);
  });

  it("exports text while excluding attachment payloads", () => {
    const messages = [
      {
        role: "user",
        text: "Old",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
      },
      {
        role: "assistant",
        text: "Old answer",
        turnId: "turn-old",
        streaming: false,
        createdAt: timestamp,
      },
      {
        role: "user",
        text: "Contains attachment",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        attachments: [{}],
      },
      {
        role: "assistant",
        text: "New answer",
        turnId: "turn-new",
        streaming: false,
        createdAt: timestamp,
      },
    ];

    expect(
      selectCompletedConversationTurns(messages, { turnId: "turn-new", state: "completed" }),
    ).toMatchObject([{ turnId: "turn-old" }, { turnId: "turn-new" }]);
  });
});
