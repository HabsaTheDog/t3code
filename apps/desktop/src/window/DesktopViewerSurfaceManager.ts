import type { DesktopViewerSurfaceInput } from "@t3tools/contracts";
import { session, WebContentsView, type BrowserWindow, type Session } from "electron";

import * as IpcChannels from "../ipc/channels.ts";

const VIEWER_SESSION_PARTITION = "persist:t3-workspace-viewer";
const surfaces = new Map<
  string,
  {
    readonly owner: BrowserWindow;
    readonly view: WebContentsView;
    url: string;
  }
>();
const observedOwners = new WeakSet<BrowserWindow>();
const hardenedSessions = new WeakSet<Session>();

function isSafeWebsiteUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function hardenSession(viewerSession: Session): void {
  if (hardenedSessions.has(viewerSession)) return;
  hardenedSessions.add(viewerSession);
  viewerSession.setPermissionCheckHandler(() => false);
  viewerSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function removeSurface(surfaceId: string): void {
  const surface = surfaces.get(surfaceId);
  if (!surface) return;
  surfaces.delete(surfaceId);
  if (!surface.owner.isDestroyed()) {
    surface.owner.contentView.removeChildView(surface.view);
  }
  if (!surface.view.webContents.isDestroyed()) {
    surface.view.webContents.close();
  }
}

function observeOwner(owner: BrowserWindow): void {
  if (observedOwners.has(owner)) return;
  observedOwners.add(owner);
  owner.once("closed", () => {
    for (const [surfaceId, surface] of surfaces) {
      if (surface.owner === owner) removeSurface(surfaceId);
    }
  });
}

function createSurface(owner: BrowserWindow, surfaceId: string, url: string) {
  const viewerSession = session.fromPartition(VIEWER_SESSION_PARTITION);
  hardenSession(viewerSession);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: viewerSession,
    },
  });

  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isSafeWebsiteUrl(popupUrl) && !owner.isDestroyed()) {
      owner.webContents.send(IpcChannels.VIEWER_OPEN_TAB_CHANNEL, popupUrl);
    }
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isSafeWebsiteUrl(navigationUrl)) event.preventDefault();
  });
  view.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  owner.contentView.addChildView(view);
  observeOwner(owner);
  const surface = { owner, view, url };
  surfaces.set(surfaceId, surface);
  void view.webContents.loadURL(url);
  return surface;
}

export function setDesktopViewerSurface(
  owner: BrowserWindow,
  input: DesktopViewerSurfaceInput,
): boolean {
  if (
    !/^[A-Za-z0-9:_-]{1,160}$/.test(input.surfaceId) ||
    !isSafeWebsiteUrl(input.url) ||
    owner.isDestroyed()
  ) {
    return false;
  }

  const existing = surfaces.get(input.surfaceId);
  const surface =
    existing?.owner === owner
      ? existing
      : (() => {
          if (existing) removeSurface(input.surfaceId);
          return createSurface(owner, input.surfaceId, input.url);
        })();

  if (surface.url !== input.url) {
    surface.url = input.url;
    void surface.view.webContents.loadURL(input.url);
  }

  surface.view.setBounds({
    x: Math.max(0, Math.round(input.bounds.x)),
    y: Math.max(0, Math.round(input.bounds.y)),
    width: Math.max(1, Math.round(input.bounds.width)),
    height: Math.max(1, Math.round(input.bounds.height)),
  });
  surface.view.setVisible(input.visible);
  return true;
}

export function destroyDesktopViewerSurface(surfaceId: string): void {
  removeSurface(surfaceId);
}
