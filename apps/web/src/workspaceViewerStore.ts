import type {
  EnvironmentId,
  PreviewFileKind,
  ScopedThreadRef,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { create } from "zustand";

export const DEFAULT_VIEWER_CHAT_WIDTH = 420;
export const MIN_VIEWER_CHAT_WIDTH = 360;
export const MAX_VIEWER_CHAT_WIDTH = 520;
export const MIN_WORKSPACE_VIEWER_WIDTH = 420;
export const WORKSPACE_VIEWER_SHEET_MEDIA_QUERY = "(max-width: 1040px)";

const CHAT_WIDTH_STORAGE_KEY = "workspace_viewer_chat_width";

export type ViewerTabSource =
  | {
      kind: "diff";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      turnId?: TurnId;
      filePath?: string;
    }
  | { kind: "plan"; environmentId: EnvironmentId; threadId: ThreadId }
  | {
      kind: "file";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      filePath: string;
      fileKind: PreviewFileKind;
    }
  | { kind: "website"; url: string };

export interface ViewerTab {
  readonly id: string;
  readonly label: string;
  readonly source: ViewerTabSource;
}

export interface ThreadViewerState {
  readonly tabs: readonly ViewerTab[];
  readonly activeTabId: string | null;
}

function clampChatWidth(width: number): number {
  return Math.min(MAX_VIEWER_CHAT_WIDTH, Math.max(MIN_VIEWER_CHAT_WIDTH, Math.round(width)));
}

function readInitialChatWidth(): number {
  if (typeof window === "undefined") return DEFAULT_VIEWER_CHAT_WIDTH;
  const parsed = Number.parseFloat(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY) ?? "");
  return Number.isFinite(parsed) ? clampChatWidth(parsed) : DEFAULT_VIEWER_CHAT_WIDTH;
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || value;
}

export function viewerTabId(source: ViewerTabSource): string {
  switch (source.kind) {
    case "plan":
      return "plan";
    case "diff":
      return `diff:${source.turnId ?? "thread"}:${source.filePath ?? "*"}`;
    case "file":
      return `file:${source.filePath}`;
    case "website":
      return `website:${source.url}`;
  }
}

export function viewerTabLabel(source: ViewerTabSource): string {
  switch (source.kind) {
    case "plan":
      return "Plan";
    case "diff":
      return source.filePath
        ? `Changes · ${basename(source.filePath)}`
        : source.turnId
          ? `Turn changes · ${String(source.turnId).slice(0, 8)}`
          : "Changes";
    case "file":
      return basename(source.filePath);
    case "website": {
      try {
        return new URL(source.url).hostname;
      } catch {
        return source.url;
      }
    }
  }
}

interface WorkspaceViewerStoreState {
  readonly viewerStateByThreadKey: Record<string, ThreadViewerState>;
  readonly chatWidth: number;
  readonly openTab: (threadRef: ScopedThreadRef, source: ViewerTabSource) => void;
  readonly activateTab: (threadRef: ScopedThreadRef, tabId: string) => void;
  readonly closeTab: (threadRef: ScopedThreadRef, tabId: string) => void;
  readonly closeAllTabs: (threadRef: ScopedThreadRef) => void;
  readonly setChatWidth: (width: number) => void;
}

const EMPTY_THREAD_VIEWER_STATE: ThreadViewerState = {
  tabs: [],
  activeTabId: null,
};

export function selectThreadViewerState(
  states: Record<string, ThreadViewerState>,
  threadRef: ScopedThreadRef,
): ThreadViewerState {
  return states[scopedThreadKey(threadRef)] ?? EMPTY_THREAD_VIEWER_STATE;
}

export const useWorkspaceViewerStore = create<WorkspaceViewerStoreState>((set) => ({
  viewerStateByThreadKey: {},
  chatWidth: readInitialChatWidth(),
  openTab: (threadRef, source) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const current = state.viewerStateByThreadKey[threadKey] ?? EMPTY_THREAD_VIEWER_STATE;
      const id = viewerTabId(source);
      const tab = { id, label: viewerTabLabel(source), source };
      const existingIndex = current.tabs.findIndex((entry) => entry.id === id);
      const tabs =
        existingIndex < 0
          ? [...current.tabs, tab]
          : current.tabs.map((entry, index) => (index === existingIndex ? tab : entry));
      return {
        viewerStateByThreadKey: {
          ...state.viewerStateByThreadKey,
          [threadKey]: { tabs, activeTabId: id },
        },
      };
    }),
  activateTab: (threadRef, tabId) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const current = state.viewerStateByThreadKey[threadKey] ?? EMPTY_THREAD_VIEWER_STATE;
      if (current.activeTabId === tabId || !current.tabs.some((tab) => tab.id === tabId)) {
        return state;
      }
      return {
        viewerStateByThreadKey: {
          ...state.viewerStateByThreadKey,
          [threadKey]: { ...current, activeTabId: tabId },
        },
      };
    }),
  closeTab: (threadRef, tabId) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const current = state.viewerStateByThreadKey[threadKey] ?? EMPTY_THREAD_VIEWER_STATE;
      const closedIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      if (closedIndex < 0) return state;
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        current.activeTabId === tabId
          ? (tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null)
          : current.activeTabId;
      return {
        viewerStateByThreadKey: {
          ...state.viewerStateByThreadKey,
          [threadKey]: { tabs, activeTabId },
        },
      };
    }),
  closeAllTabs: (threadRef) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      if (!state.viewerStateByThreadKey[threadKey]) return state;
      return {
        viewerStateByThreadKey: {
          ...state.viewerStateByThreadKey,
          [threadKey]: EMPTY_THREAD_VIEWER_STATE,
        },
      };
    }),
  setChatWidth: (width) => {
    const chatWidth = clampChatWidth(width);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(chatWidth));
    }
    set({ chatWidth });
  },
}));
