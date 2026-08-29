import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";

const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopServerExposure.DesktopServerExposure
  | DesktopState.DesktopState
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

export class DesktopWindowDevServerUrlMissingError extends Data.TaggedError(
  "DesktopWindowDevServerUrlMissingError",
)<{}> {
  override get message() {
    return "VITE_DEV_SERVER_URL is required in desktop development.";
  }
}

export type DesktopWindowError =
  | DesktopWindowDevServerUrlMissingError
  | ElectronWindow.ElectronWindowCreateError;

export interface DesktopWindowShape {
  readonly createStartupMain: Effect.Effect<void, DesktopWindowError>;
  readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
  readonly activate: Effect.Effect<void, DesktopWindowError>;
  readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
  readonly handleBackendReady: Effect.Effect<void, DesktopWindowError>;
  readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
  readonly syncAppearance: Effect.Effect<void>;
}

export class DesktopWindow extends Context.Service<DesktopWindow, DesktopWindowShape>()(
  "@t3tools/desktop/window/DesktopWindow",
) {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  DesktopObservability.makeComponentLogger("desktop-window");

function resolveDesktopDevServerUrl(
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): Effect.Effect<string, DesktopWindowDevServerUrlMissingError> {
  return Option.match(environment.devServerUrl, {
    onNone: () => Effect.fail(new DesktopWindowDevServerUrlMissingError()),
    onSome: (url) => Effect.succeed(url.href),
  });
}

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function getStartupDocumentUrl(displayName: string, shouldUseDarkColors: boolean): string {
  const background = shouldUseDarkColors ? "#0b1020" : "#f6f7fb";
  const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <meta name="color-scheme" content="${shouldUseDarkColors ? "dark" : "light"}">
    <title>${displayName}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        display: grid;
        place-items: center;
        background: ${background};
        -webkit-user-select: none;
        user-select: none;
      }
      .drag-region {
        position: fixed;
        inset: 0 0 auto 0;
        height: ${TITLEBAR_HEIGHT}px;
        -webkit-app-region: drag;
      }
      main {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 18px;
      }
      svg { width: 64px; height: 64px; }
      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid rgb(200 155 60 / 28%);
        border-top-color: #c89b3c;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    </style>
  </head>
  <body>
    <div class="drag-region" aria-hidden="true"></div>
    <main aria-label="${displayName} is starting">
      <svg viewBox="0 0 64 64" role="img" aria-label="Study Buddy">
        <path fill="#c89b3c" d="M4 23 32 9l28 14-28 14L4 23Zm10 9 18 9 18-9v12c-5 5-11 8-18 8s-13-3-18-8V32Z"/>
        <path fill="#e8c76c" d="M57 25h3v17h-3zM55 42h7v5h-7z"/>
      </svg>
      <div class="spinner" role="status" aria-label="Starting Study Buddy"></div>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

export function isMainWindowPermissionAllowed(permission: string): boolean {
  return permission === "media" || permission === "clipboard-sanitized-write";
}

function getWindowTitleBarOptions(shouldUseDarkColors: boolean): WindowTitleBarOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const state = yield* DesktopState.DesktopState;
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const startupWindows = new WeakSet<Electron.BrowserWindow>();
  const applicationUrls = new WeakMap<Electron.BrowserWindow, string>();
  const pendingMenuActions = new WeakMap<Electron.BrowserWindow, string[]>();

  const sendMenuAction = (window: Electron.BrowserWindow, action: string) => {
    if (window.isDestroyed()) return;
    window.webContents.send(IpcChannels.MENU_ACTION_CHANNEL, action);
    void runPromise(electronWindow.reveal(window));
  };

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (
    initialUrl: string,
    applicationUrl: string | undefined,
    openDevTools: boolean,
    revealImmediately: boolean,
  ): Effect.fn.Return<Electron.BrowserWindow, DesktopWindowError> {
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const window = yield* electronWindow.create({
      width: 1100,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors),
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.webContents.session.setPermissionCheckHandler((_webContents, permission) =>
      isMainWindowPermissionAllowed(permission),
    );
    window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) =>
      callback(isMainWindowPermissionAllowed(permission)),
    );

    window.webContents.on("context-menu", (event, params) => {
      event.preventDefault();

      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          menuTemplate.push({
            label: suggestion,
            click: () => window.webContents.replaceMisspelling(suggestion),
          });
        }
        if (params.dictionarySuggestions.length === 0) {
          menuTemplate.push({ label: "No suggestions", enabled: false });
        }
        menuTemplate.push({ type: "separator" });
      }

      if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
        menuTemplate.push(
          {
            label: "Copy Link",
            click: () => {
              void runPromise(electronShell.copyText(params.linkURL));
            },
          },
          { type: "separator" },
        );
      }

      if (params.mediaType === "image") {
        menuTemplate.push({
          label: "Copy Image",
          click: () => window.webContents.copyImageAt(params.x, params.y),
        });
        menuTemplate.push({ type: "separator" });
      }

      menuTemplate.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );

      void runPromise(electronMenu.popupTemplate({ window, template: menuTemplate }));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const allowedApplicationUrl = applicationUrls.get(window);
      if (
        allowedApplicationUrl !== undefined &&
        isSameOriginRendererNavigation({
          applicationUrl: allowedApplicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.webContents.on("did-finish-load", () => {
      window.setTitle(environment.displayName);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      void runPromise(
        logWindowWarning("main window render process gone", {
          reason: details.reason,
          exitCode: details.exitCode,
        }),
      );
    });

    if (!revealImmediately) {
      const revealSubscribers: RevealSubscription[] = [
        (fire) => window.once("ready-to-show", fire),
      ];
      if (process.platform === "linux") {
        revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
      }
      bindFirstRevealTrigger(revealSubscribers, () => {
        void runPromise(electronWindow.reveal(window));
      });
    }

    if (applicationUrl !== undefined) {
      applicationUrls.set(window, applicationUrl);
    }
    void window.loadURL(initialUrl);
    if (revealImmediately) {
      yield* electronWindow.reveal(window);
    }
    if (openDevTools) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const resolveApplicationUrl = Effect.gen(function* () {
    if (environment.isDevelopment) {
      return yield* resolveDesktopDevServerUrl(environment);
    }
    const backendConfig = yield* serverExposure.backendConfig;
    return backendConfig.httpBaseUrl.href;
  });

  const loadApplication = Effect.fn("desktop.window.loadApplication")(function* (
    window: Electron.BrowserWindow,
  ) {
    if (!startupWindows.has(window) || window.isDestroyed()) {
      return;
    }
    const applicationUrl = yield* resolveApplicationUrl;
    startupWindows.delete(window);
    applicationUrls.set(window, applicationUrl);
    const queuedActions = pendingMenuActions.get(window) ?? [];
    pendingMenuActions.delete(window);
    if (queuedActions.length > 0) {
      window.webContents.once("did-finish-load", () => {
        for (const action of queuedActions) sendMenuAction(window, action);
      });
    }
    void window.loadURL(applicationUrl);
    yield* logWindowInfo("startup window loading main application");
  });

  const createMain = Effect.gen(function* () {
    const applicationUrl = yield* resolveApplicationUrl;
    const window = yield* createWindow(
      applicationUrl,
      applicationUrl,
      environment.isDevelopment,
      false,
    );
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) {
      return existingWindow.value;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    const backendReady = yield* Ref.get(state.backendReady);
    if (!backendReady) return;
    const existingWindow = yield* electronWindow.main;
    if (Option.isSome(existingWindow)) {
      yield* loadApplication(existingWindow.value);
      return;
    }
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  return DesktopWindow.of({
    createStartupMain: Effect.gen(function* () {
      if (environment.isDevelopment) {
        return;
      }
      const existingWindow = yield* electronWindow.main;
      if (Option.isSome(existingWindow)) {
        return;
      }
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      const startupUrl = getStartupDocumentUrl(environment.displayName, shouldUseDarkColors);
      const window = yield* createWindow(startupUrl, undefined, false, true);
      startupWindows.add(window);
      yield* electronWindow.setMain(window);
      yield* logWindowInfo("startup window created");
    }).pipe(Effect.withSpan("desktop.window.createStartupMain")),
    createMain,
    ensureMain,
    revealOrCreateMain,
    activate: Effect.gen(function* () {
      const existingWindow = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
      } else {
        yield* createMainIfBackendReady;
      }
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    handleBackendReady: Effect.gen(function* () {
      yield* Ref.set(state.backendReady, true);
      yield* logWindowInfo("backend ready", { source: "http" });
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.handleBackendReady")),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action) {
      yield* Effect.annotateCurrentSpan({ action });
      const existingWindow = yield* electronWindow.focusedMainOrFirst;
      const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* createMain;

      if (startupWindows.has(targetWindow)) {
        const queuedActions = pendingMenuActions.get(targetWindow) ?? [];
        pendingMenuActions.set(targetWindow, [...queuedActions, action]);
        return;
      }

      const send = () => sendMenuAction(targetWindow, action);

      if (targetWindow.webContents.isLoadingMainFrame()) {
        targetWindow.webContents.once("did-finish-load", send);
        return;
      }

      send();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
