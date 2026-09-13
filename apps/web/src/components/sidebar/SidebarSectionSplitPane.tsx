import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import {
  clampSidebarQuickChatPaneRatio,
  DEFAULT_SIDEBAR_QUICK_CHAT_PANE_RATIO,
  getSidebarQuickChatPaneRatioFromPointer,
  MAX_SIDEBAR_QUICK_CHAT_PANE_RATIO,
  MIN_SIDEBAR_QUICK_CHAT_PANE_RATIO,
} from "../Sidebar.logic";

export const SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY =
  "study-buddy:sidebar-quick-chat-pane-ratio:v1";

export function SidebarSectionSplitPane({
  quickChats,
  projects,
}: {
  quickChats: ReactNode;
  projects: ReactNode;
}) {
  const [storedQuickChatPaneRatio, setStoredQuickChatPaneRatio] = useLocalStorage(
    SIDEBAR_QUICK_CHAT_PANE_RATIO_STORAGE_KEY,
    DEFAULT_SIDEBAR_QUICK_CHAT_PANE_RATIO,
    Schema.Finite,
  );
  const [quickChatPaneRatio, setQuickChatPaneRatio] = useState(() =>
    clampSidebarQuickChatPaneRatio(storedQuickChatPaneRatio),
  );
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const dividerDragRef = useRef<{ pointerId: number; ratio: number } | null>(null);

  useEffect(() => {
    if (dividerDragRef.current) return;
    setQuickChatPaneRatio(clampSidebarQuickChatPaneRatio(storedQuickChatPaneRatio));
  }, [storedQuickChatPaneRatio]);

  useEffect(
    () => () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  const persistQuickChatPaneRatio = useCallback(
    (ratio: number) => {
      const clampedRatio = clampSidebarQuickChatPaneRatio(ratio);
      setQuickChatPaneRatio(clampedRatio);
      setStoredQuickChatPaneRatio(clampedRatio);
    },
    [setStoredQuickChatPaneRatio],
  );

  const finishDividerDrag = useCallback(
    (element: HTMLDivElement, pointerId: number) => {
      const drag = dividerDragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      dividerDragRef.current = null;
      setStoredQuickChatPaneRatio(drag.ratio);
      if (element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [setStoredQuickChatPaneRatio],
  );

  return (
    <div
      ref={splitPaneRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="sidebar-section-split-pane"
    >
      <div
        className="min-h-0 shrink-0 overflow-hidden"
        data-testid="quick-chat-pane"
        style={{ flexBasis: `${quickChatPaneRatio * 100}%` }}
      >
        {quickChats}
      </div>
      <div
        role="separator"
        aria-label="Resize Quick Chats and Projects"
        aria-orientation="horizontal"
        aria-valuemin={Math.round(MIN_SIDEBAR_QUICK_CHAT_PANE_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SIDEBAR_QUICK_CHAT_PANE_RATIO * 100)}
        aria-valuenow={Math.round(quickChatPaneRatio * 100)}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        data-testid="sidebar-quick-chat-resize-handle"
        className="group relative h-2.5 shrink-0 cursor-row-resize touch-none outline-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dividerDragRef.current = {
            pointerId: event.pointerId,
            ratio: quickChatPaneRatio,
          };
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(event) => {
          const drag = dividerDragRef.current;
          const container = splitPaneRef.current;
          if (!drag || drag.pointerId !== event.pointerId || !container) return;
          const bounds = container.getBoundingClientRect();
          const ratio = getSidebarQuickChatPaneRatioFromPointer({
            clientY: event.clientY,
            containerTop: bounds.top,
            containerHeight: bounds.height,
          });
          drag.ratio = ratio;
          setQuickChatPaneRatio(ratio);
        }}
        onPointerUp={(event) => finishDividerDrag(event.currentTarget, event.pointerId)}
        onPointerCancel={(event) => finishDividerDrag(event.currentTarget, event.pointerId)}
        onDoubleClick={() => {
          persistQuickChatPaneRatio(DEFAULT_SIDEBAR_QUICK_CHAT_PANE_RATIO);
        }}
        onKeyDown={(event) => {
          let nextRatio: number | null = null;
          if (event.key === "ArrowUp") nextRatio = quickChatPaneRatio - 0.05;
          if (event.key === "ArrowDown") nextRatio = quickChatPaneRatio + 0.05;
          if (event.key === "Home") nextRatio = MIN_SIDEBAR_QUICK_CHAT_PANE_RATIO;
          if (event.key === "End") nextRatio = MAX_SIDEBAR_QUICK_CHAT_PANE_RATIO;
          if (nextRatio === null) return;
          event.preventDefault();
          persistQuickChatPaneRatio(nextRatio);
        }}
      >
        <div className="absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-sidebar-border transition-colors group-hover:bg-foreground/25 group-focus-visible:bg-primary/60" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" data-testid="projects-pane">
        {projects}
      </div>
    </div>
  );
}
