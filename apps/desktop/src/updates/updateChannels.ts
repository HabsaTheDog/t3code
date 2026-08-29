import type { DesktopUpdateChannel } from "@t3tools/contracts";

const PRERELEASE_CHANNEL_PATTERN = /-(alpha|beta|nightly)(?:\.|$)/;

export function isNightlyDesktopVersion(version: string): boolean {
  return resolveDefaultDesktopUpdateChannel(version) === "nightly";
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  const match = appVersion.match(PRERELEASE_CHANNEL_PATTERN);
  if (match?.[1] === "alpha" || match?.[1] === "beta" || match?.[1] === "nightly") {
    return match[1];
  }
  return "latest";
}
