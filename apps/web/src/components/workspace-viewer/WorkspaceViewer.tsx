import type { FilesystemPreviewTicket, ScopedThreadRef } from "@t3tools/contracts";
import {
  CodeXmlIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  XIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { resolveEnvironmentHttpUrl } from "../../environments/runtime";
import { readEnvironmentApi } from "../../environmentApi";
import { openInSystemApplication } from "../../editorPreferences";
import { readLocalApi } from "../../localApi";
import {
  MAX_VIEWER_CHAT_WIDTH,
  MIN_VIEWER_CHAT_WIDTH,
  selectThreadViewerState,
  type ViewerTab,
  type ViewerTabSource,
  useWorkspaceViewerStore,
} from "../../workspaceViewerStore";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { isElectron } from "../../env";
import { htmlFilePreviewSandbox } from "./filePreviewSandbox";

interface WorkspaceViewerProps {
  readonly threadRef: ScopedThreadRef;
  readonly renderDiff: () => ReactNode;
  readonly renderPlan: () => ReactNode;
  readonly onActiveSourceChange?: (source: ViewerTabSource | null) => void;
  readonly className?: string;
}

function tabIcon(tab: ViewerTab) {
  switch (tab.source.kind) {
    case "diff":
      return <CodeXmlIcon className="size-3.5" />;
    case "plan":
      return <ListChecksIcon className="size-3.5" />;
    case "website":
      return <GlobeIcon className="size-3.5" />;
    case "file":
      return tab.source.fileKind === "image" ? (
        <ImageIcon className="size-3.5" />
      ) : tab.source.fileKind === "markdown" || tab.source.fileKind === "text" ? (
        <FileTextIcon className="size-3.5" />
      ) : (
        <FileIcon className="size-3.5" />
      );
  }
}

function WorkspaceViewerEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      <div className="flex size-10 items-center justify-center rounded-xl border border-border/70 bg-muted/25">
        <FileIcon className="size-4" />
      </div>
      <p className="text-xs">Nothing open in the viewer.</p>
    </div>
  );
}

function ViewerLoadingState() {
  return (
    <div className="flex h-full flex-col gap-3 p-4" role="status" aria-label="Loading preview">
      <Skeleton className="h-5 w-48 rounded-md" />
      <Skeleton className="min-h-0 flex-1 rounded-lg" />
    </div>
  );
}

function ViewerErrorState({ message }: { readonly message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm rounded-lg border border-destructive/25 bg-destructive/5 p-4">
        <p className="text-sm font-medium text-foreground">Preview unavailable</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function FilePreview({ source }: { readonly source: Extract<ViewerTabSource, { kind: "file" }> }) {
  const [ticket, setTicket] = useState<FilesystemPreviewTicket | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setTicket(null);
    setPreviewUrl(null);
    setText(null);
    setError(null);
    const api = readEnvironmentApi(source.environmentId);
    if (!api) {
      setError("The selected environment is not connected.");
      return;
    }

    void api.filesystem
      .createPreviewTicket({
        scope: { kind: "thread", threadId: source.threadId },
        filePath: source.filePath,
      })
      .then(async (nextTicket) => {
        if (disposed) return;
        const url = resolveEnvironmentHttpUrl({
          environmentId: source.environmentId,
          pathname: nextTicket.path,
        });
        setTicket(nextTicket);
        setPreviewUrl(url);
        if (nextTicket.fileKind === "markdown" || nextTicket.fileKind === "text") {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);
          const nextText = await response.text();
          if (!disposed) setText(nextText);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : "Unable to load this file.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [source.environmentId, source.filePath, source.threadId]);

  if (error) return <ViewerErrorState message={error} />;
  if (!ticket || !previewUrl) return <ViewerLoadingState />;

  if (ticket.fileKind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[radial-gradient(circle_at_center,var(--color-muted)_1px,transparent_1px)] bg-[size:16px_16px] p-5">
        <img
          src={previewUrl}
          alt={ticket.fileName}
          className="max-h-full max-w-full rounded-md object-contain shadow-lg"
        />
      </div>
    );
  }

  if (ticket.fileKind === "markdown") {
    return (
      <div className="h-full overflow-auto px-6 py-5">
        {text === null ? (
          <ViewerLoadingState />
        ) : (
          <ChatMarkdown
            text={text}
            cwd={source.filePath}
            isStreaming={false}
            viewerThreadRef={{
              environmentId: source.environmentId,
              threadId: source.threadId,
            }}
            onOpenViewerTab={(nextSource) => {
              useWorkspaceViewerStore
                .getState()
                .openTab(
                  { environmentId: source.environmentId, threadId: source.threadId },
                  nextSource,
                );
            }}
          />
        )}
      </div>
    );
  }

  if (ticket.fileKind === "text") {
    return text === null ? (
      <ViewerLoadingState />
    ) : (
      <pre className="h-full overflow-auto whitespace-pre-wrap wrap-break-word p-5 font-mono text-xs leading-relaxed text-foreground/85">
        {text}
      </pre>
    );
  }

  if (ticket.fileKind === "file") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <FileIcon className="size-8 text-muted-foreground/55" />
        <div>
          <p className="text-sm font-medium">{ticket.fileName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This file type has no embedded renderer.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const api = readLocalApi();
            if (!api) return;
            void openInSystemApplication(api, source.filePath);
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open externally
        </Button>
      </div>
    );
  }

  return (
    <iframe
      title={ticket.fileName}
      src={previewUrl}
      className="h-full w-full border-0 bg-white"
      sandbox={
        ticket.fileKind === "html"
          ? htmlFilePreviewSandbox(previewUrl, window.location.href)
          : undefined
      }
    />
  );
}

function NativeWebsitePreview({
  url,
  threadRef,
}: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const surfaceId = useMemo(() => `viewer-${reactId.replaceAll(":", "-")}`, [reactId]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    const host = hostRef.current;
    if (!bridge?.setViewerSurface || !bridge.destroyViewerSurface || !host) return;
    let frame = 0;

    const updateSurface = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        const hostVisible = window.getComputedStyle(host).visibility !== "hidden";
        const coveredByGlobalDialog = [
          ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
        ].some((dialog) => !dialog.contains(host));
        void bridge.setViewerSurface({
          surfaceId,
          url,
          bounds: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          visible:
            rect.width >= 1 &&
            rect.height >= 1 &&
            hostVisible &&
            !coveredByGlobalDialog &&
            document.visibilityState === "visible",
        });
      });
    };

    const resizeObserver = new ResizeObserver(updateSurface);
    resizeObserver.observe(host);
    const mutationObserver = new MutationObserver(updateSurface);
    mutationObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", updateSurface);
    window.addEventListener("scroll", updateSurface, true);
    document.addEventListener("visibilitychange", updateSurface);
    updateSurface();

    const unsubscribePopup = bridge.onViewerOpenTab?.((popupUrl) => {
      useWorkspaceViewerStore.getState().openTab(threadRef, {
        kind: "website",
        url: popupUrl,
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateSurface);
      window.removeEventListener("scroll", updateSurface, true);
      document.removeEventListener("visibilitychange", updateSurface);
      unsubscribePopup?.();
      void bridge.destroyViewerSurface(surfaceId);
    };
  }, [surfaceId, threadRef, url]);

  return (
    <div ref={hostRef} className="h-full w-full bg-white" aria-label={`Website preview: ${url}`} />
  );
}

function WebsitePreview({
  url,
  threadRef,
}: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
}) {
  if (isElectron && window.desktopBridge?.setViewerSurface) {
    return <NativeWebsitePreview url={url} threadRef={threadRef} />;
  }
  return (
    <iframe
      title={url}
      src={url}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

export function WorkspaceViewer({
  threadRef,
  renderDiff,
  renderPlan,
  onActiveSourceChange,
  className,
}: WorkspaceViewerProps) {
  const state = useWorkspaceViewerStore((store) =>
    selectThreadViewerState(store.viewerStateByThreadKey, threadRef),
  );
  const activateTab = useWorkspaceViewerStore((store) => store.activateTab);
  const closeTab = useWorkspaceViewerStore((store) => store.closeTab);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;

  useEffect(() => {
    onActiveSourceChange?.(activeTab?.source ?? null);
  }, [activeTab?.source, onActiveSourceChange]);

  const openExternal = useCallback((source: ViewerTabSource) => {
    const api = readLocalApi();
    if (!api) return;
    const operation =
      source.kind === "website"
        ? api.shell.openExternal(source.url)
        : source.kind === "file"
          ? openInSystemApplication(api, source.filePath)
          : Promise.resolve();
    void operation.catch((cause: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open externally",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      );
    });
  }, []);

  const handleTabContextMenu = useCallback(
    async (event: React.MouseEvent, tab: ViewerTab) => {
      if (tab.source.kind !== "file" && tab.source.kind !== "website") return;
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const value = tab.source.kind === "file" ? tab.source.filePath : tab.source.url;
      const selected = await api.contextMenu.show(
        [
          { id: "viewer", label: "Open in viewer" },
          { id: "external", label: "Open externally" },
          { id: "copy", label: tab.source.kind === "file" ? "Copy path" : "Copy URL" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      );
      if (selected === "viewer") activateTab(threadRef, tab.id);
      if (selected === "external") openExternal(tab.source);
      if (selected === "copy") await navigator.clipboard.writeText(value);
    },
    [activateTab, openExternal, threadRef],
  );

  const content = useMemo(() => {
    if (!activeTab) return <WorkspaceViewerEmptyState />;
    switch (activeTab.source.kind) {
      case "diff":
        return renderDiff();
      case "plan":
        return renderPlan();
      case "file":
        return <FilePreview source={activeTab.source} />;
      case "website":
        return null;
    }
  }, [activeTab, renderDiff, renderPlan, threadRef]);

  return (
    <section
      aria-label="Workspace viewer"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-end border-b border-border bg-muted/20 px-1.5 pt-1">
        <div
          role="tablist"
          aria-label="Open viewer tabs"
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
        >
          {state.tabs.map((tab) => {
            const active = tab.id === activeTab?.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.label}
                className={cn(
                  "group flex h-8 max-w-52 min-w-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[11px] transition-colors",
                  active
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
                onClick={() => activateTab(threadRef, tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(threadRef, tab.id);
                }}
                onContextMenu={(event) => void handleTabContextMenu(event, tab)}
              >
                <span className="shrink-0">{tabIcon(tab)}</span>
                <span className="truncate">{tab.label}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${tab.label}`}
                  className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-sm opacity-45 hover:bg-muted hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(threadRef, tab.id);
                  }}
                >
                  <XIcon className="size-3" />
                </span>
              </button>
            );
          })}
        </div>
        {activeTab && (activeTab.source.kind === "file" || activeTab.source.kind === "website") ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="mb-1 ml-1 shrink-0 text-muted-foreground"
            aria-label="Open externally"
            title="Open externally"
            onClick={() => openExternal(activeTab.source)}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {content}
        {state.tabs
          .filter(
            (
              tab,
            ): tab is ViewerTab & {
              source: Extract<ViewerTabSource, { kind: "website" }>;
            } => tab.source.kind === "website",
          )
          .map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                tab.id === activeTab?.id ? "block" : "pointer-events-none invisible",
              )}
            >
              <WebsitePreview url={tab.source.url} threadRef={threadRef} />
            </div>
          ))}
      </div>
    </section>
  );
}

export function ChatViewerResizeHandle() {
  const chatWidth = useWorkspaceViewerStore((store) => store.chatWidth);
  const setChatWidth = useWorkspaceViewerStore((store) => store.setChatWidth);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: chatWidth,
      };
    },
    [chatWidth],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={MIN_VIEWER_CHAT_WIDTH}
      aria-valuemax={MAX_VIEWER_CHAT_WIDTH}
      aria-valuenow={chatWidth}
      tabIndex={0}
      className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setChatWidth(drag.startWidth + event.clientX - drag.startX);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setChatWidth(chatWidth + (event.key === "ArrowLeft" ? -16 : 16));
      }}
    >
      <div className="absolute inset-y-0 -left-1.5 w-3 transition-colors group-hover:bg-primary/15 group-focus-visible:bg-primary/20" />
    </div>
  );
}
