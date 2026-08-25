// @effect-diagnostics nodeBuiltinImport:off
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import path from "node:path";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopSourceSecretKeyStore from "../app/DesktopSourceSecretKeyStore.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

export interface DesktopBackendConfigurationShape {
  readonly resolve: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError | DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStoreError
  >;
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  DesktopBackendConfigurationShape
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
] as const;

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

export function systemBrowserPathCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const configured = [
    environment.STUDY_BUDDY_BROWSER_EXECUTABLE,
    environment.PLAYWRIGHT_EXECUTABLE_PATH,
  ].flatMap((entry) => (entry?.trim() ? [entry.trim()] : []));
  if (platform === "win32") {
    for (const root of [
      environment.PROGRAMFILES,
      environment["PROGRAMFILES(X86)"],
      environment.LOCALAPPDATA,
    ]) {
      if (!root?.trim()) continue;
      configured.push(
        `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${root}\\Google\\Chrome\\Application\\chrome.exe`,
        `${root}\\Chromium\\Application\\chrome.exe`,
      );
    }
  } else if (platform === "linux") {
    configured.push(
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    );
  }
  return [...new Set(configured)];
}

const resolveSystemBrowserPath = Effect.fn("desktop.resolveSystemBrowserPath")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of systemBrowserPathCandidates(process.platform, process.env)) {
    const isAbsolute =
      process.platform === "win32"
        ? path.win32.isAbsolute(candidate)
        : path.posix.isAbsolute(candidate);
    if (!isAbsolute) continue;
    const metadata = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => null));
    if (metadata?.type === "File") {
      return candidate;
    }
  }
  return undefined;
});

const { logWarning: logBackendConfigurationWarning } = DesktopObservability.makeComponentLogger(
  "desktop-backend-configuration",
);

const readPersistedBackendObservabilitySettings: Effect.Effect<
  BackendObservabilitySettings,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const exists = yield* fileSystem
    .exists(environment.serverSettingsPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return emptyBackendObservabilitySettings;
  }

  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    yield* logBackendConfigurationWarning(
      "failed to read persisted backend observability settings",
    );
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
  };
});

const resolveBackendStartConfig = Effect.fn("desktop.backendConfiguration.resolveStartConfig")(
  function* (input: {
    readonly bootstrapToken: string;
    readonly sourceSecretKey: string;
    readonly observabilitySettings: BackendObservabilitySettings;
  }): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    | DesktopEnvironment.DesktopEnvironment
    | DesktopServerExposure.DesktopServerExposure
    | FileSystem.FileSystem
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;
    const browserExecutablePath = yield* resolveSystemBrowserPath();
    const pathSeparator = environment.platform === "win32" ? ";" : ":";

    return {
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
        APP_VERSION: environment.appVersion,
        STUDY_BUDDY_ROOT: environment.studyBuddyRoot,
        STUDY_BUDDY_T3_ROOT: environment.appRoot,
        STUDY_BUDDY_TASK_WRAPPER: environment.studyBuddyTaskWrapperPath,
        STUDY_BUDDY_NODE_EXECUTABLE: process.execPath,
        PATH: `${environment.studyBuddyRuntimeBinPath}${pathSeparator}${process.env.PATH ?? ""}`,
        ...(browserExecutablePath
          ? {
              PLAYWRIGHT_EXECUTABLE_PATH: browserExecutablePath,
              STUDY_BUDDY_BROWSER_EXECUTABLE: browserExecutablePath,
            }
          : {}),
      },
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: backendExposure.port,
        t3Home: environment.baseDir,
        host: backendExposure.bindHost,
        desktopBootstrapToken: input.bootstrapToken,
        sourceSecretKey: input.sourceSecretKey,
        tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
        tailscaleServePort: backendExposure.tailscaleServePort,
        ...Option.match(input.observabilitySettings.otlpTracesUrl, {
          onNone: () => ({}),
          onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
        }),
        ...Option.match(input.observabilitySettings.otlpMetricsUrl, {
          onNone: () => ({}),
          onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
        }),
      },
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
    };
  },
);

export const layer = Layer.effect(
  DesktopBackendConfiguration,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const crypto = yield* Crypto.Crypto;
    const sourceSecretKeyStore = yield* DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore;
    const tokenRef = yield* Ref.make(Option.none<string>());
    const getOrCreateBootstrapToken = Effect.gen(function* () {
      const existing = yield* Ref.get(tokenRef);
      if (Option.isSome(existing)) {
        return existing.value;
      }

      const token = Encoding.encodeHex(yield* crypto.randomBytes(24));
      yield* Ref.set(tokenRef, Option.some(token));
      return token;
    });

    return DesktopBackendConfiguration.of({
      resolve: Effect.gen(function* () {
        const bootstrapToken = yield* getOrCreateBootstrapToken;
        const sourceSecretKey = yield* sourceSecretKeyStore.getOrCreate;
        const observabilitySettings = yield* readPersistedBackendObservabilitySettings.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        );
        return yield* resolveBackendStartConfig({
          bootstrapToken,
          sourceSecretKey,
          observabilitySettings,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
        );
      }).pipe(Effect.withSpan("desktop.backendConfiguration.resolve")),
    });
  }),
);
