// @effect-diagnostics nodeBuiltinImport:off
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const BROWSER_RUNTIME_MISSING_CODE = "browser-runtime-missing";

export class BrowserRuntimeMissingError extends Error {
  readonly code = BROWSER_RUNTIME_MISSING_CODE;

  constructor(platform: NodeJS.Platform) {
    super(
      `Study Buddy could not find a supported system browser on ${platform}. Install Microsoft Edge, Google Chrome, or Chromium and try again.`,
    );
    this.name = "BrowserRuntimeMissingError";
  }
}

export interface BrowserRuntimeResolutionInput {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly pathExists?: (candidate: string) => Promise<boolean>;
}

function configuredCandidates(environment: NodeJS.ProcessEnv): string[] {
  return [
    environment.STUDY_BUDDY_BROWSER_EXECUTABLE,
    environment.PLAYWRIGHT_EXECUTABLE_PATH,
  ].flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function systemBrowserCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  const candidates = configuredCandidates(environment);
  if (platform === "win32") {
    const roots = [
      environment.PROGRAMFILES,
      environment["PROGRAMFILES(X86)"],
      environment.LOCALAPPDATA,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    for (const root of roots) {
      candidates.push(
        path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.win32.join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (platform === "linux") {
    candidates.push(
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/var/lib/flatpak/exports/bin/com.google.Chrome",
      "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    );
    const pathEntries = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const directory of pathEntries) {
      for (const executable of [
        "microsoft-edge-stable",
        "google-chrome-stable",
        "google-chrome",
        "chromium-browser",
        "chromium",
      ]) {
        candidates.push(path.join(directory, executable));
      }
    }
  }
  return [...new Set(candidates)];
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  try {
    const resolved = await realpath(candidate);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) return false;
    if (process.platform !== "win32") await access(resolved, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSystemBrowserExecutable(
  input: BrowserRuntimeResolutionInput = {},
): Promise<string> {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  const pathExists = input.pathExists ?? isExecutableFile;
  for (const candidate of systemBrowserCandidates(platform, environment)) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new BrowserRuntimeMissingError(platform);
}

export function isBrowserRuntimeMissingError(error: unknown): error is BrowserRuntimeMissingError {
  return (
    error instanceof BrowserRuntimeMissingError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === BROWSER_RUNTIME_MISSING_CODE)
  );
}
