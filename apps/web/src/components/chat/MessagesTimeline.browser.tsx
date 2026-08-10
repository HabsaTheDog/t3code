import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
const getStateSpy = vi.fn(() => ({
  isAtEnd: true,
  scroll: 0,
  scrollLength: 1_000,
  positionAtIndex: (index: number) => index * 100,
  sizeAtIndex: () => 80,
}));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ref?: React.Ref<LegendListRef>;
  }) {
    React.useImperativeHandle(
      props.ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          scrollToIndex: scrollToIndexSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";

const MESSAGE_CREATED_AT = "2026-04-13T12:00:00.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    activeThreadId: ThreadId.make("thread-1"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1" as never,
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildCompletedExchanges() {
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    turnId: string | null,
    createdAt: string,
    completedAt?: string,
  ) => ({
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
  });
  const work = (id: string, turnId: string, createdAt: string, detail: string) => ({
    id,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      turnId: turnId as never,
      createdAt,
      label: "Tool call",
      detail,
      tone: "tool" as const,
    },
  });

  return [
    message("user-1", "user", "First question", null, "2026-04-13T12:00:00.000Z"),
    work("work-1", "turn-1", "2026-04-13T12:00:03.000Z", "First hidden tool"),
    message(
      "assistant-1",
      "assistant",
      "First answer",
      "turn-1",
      "2026-04-13T12:00:08.000Z",
      "2026-04-13T12:00:10.000Z",
    ),
    message("user-2", "user", "Second question", null, "2026-04-13T12:00:20.000Z"),
    work("work-2", "turn-2", "2026-04-13T12:00:23.000Z", "Second hidden tool"),
    message(
      "assistant-2",
      "assistant",
      "Second answer",
      "turn-2",
      "2026-04-13T12:00:24.000Z",
      "2026-04-13T12:00:25.000Z",
    ),
  ];
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    scrollToIndexSpy.mockReset();
    getStateSpy.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("starts long user messages collapsed by default", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: "Show full message" });
      await expect.element(toggle).toBeVisible();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

      const messageBody = document.querySelector(
        "[data-user-message-body='true']",
      ) as HTMLDivElement | null;
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.className).toContain("overflow-hidden");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect(messageBody?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("expands and re-collapses long user messages from the toggle", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const expandButton = page.getByRole("button", { name: "Show full message" });
      await expect.element(expandButton).toBeVisible();

      expect(document.body.textContent ?? "").toContain("deep hidden detail only after expand");

      await expandButton.click();

      const collapseButton = page.getByRole("button", { name: "Show less" });
      await expect.element(collapseButton).toBeVisible();
      await expect.element(collapseButton).toHaveAttribute("aria-expanded", "true");

      let messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("false");
      expect(messageBody?.className).not.toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("false");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage ?? "").toBe("");

      await collapseButton.click();

      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();
      messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("starts the newest long user prompt collapsed", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText("latest long prompt"))]}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();

      const messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("expands completed exchanges independently", async () => {
    const screen = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={buildCompletedExchanges()} />,
    );

    try {
      await expect.element(page.getByText("First hidden tool")).not.toBeInTheDocument();
      await expect.element(page.getByText("Second hidden tool")).not.toBeInTheDocument();

      const firstFold = page.getByRole("button", { name: "Worked for 10s" });
      await expect.element(firstFold).toHaveAttribute("aria-expanded", "false");
      await firstFold.click();

      await expect.element(page.getByText("First hidden tool")).toBeVisible();
      await expect.element(page.getByText("Second hidden tool")).not.toBeInTheDocument();
      await expect.element(firstFold).toHaveAttribute("aria-expanded", "true");

      await firstFold.click();
      await expect.element(page.getByText("First hidden tool")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the enlarged minimap and supports keyboard navigation", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline {...props} timelineEntries={buildCompletedExchanges()} />,
    );

    try {
      const minimap = document.querySelector("[data-testid='timeline-minimap']");
      const rail = minimap?.querySelector("button") as HTMLButtonElement | null;
      expect(minimap).not.toBeNull();
      expect(rail?.className).toContain("w-12");
      expect(document.querySelectorAll("[data-minimap-strip]")).toHaveLength(2);
      expect(document.querySelector("[data-minimap-strip]")?.className).toContain("h-[3px]");

      rail?.focus();
      rail?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      await expect
        .element(page.getByRole("button", { name: "Jump to message: Second question" }))
        .toBeVisible();
      rail?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(scrollToIndexSpy).toHaveBeenCalledWith({
        index: 3,
        animated: true,
        viewOffset: 24,
      });
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });
});
