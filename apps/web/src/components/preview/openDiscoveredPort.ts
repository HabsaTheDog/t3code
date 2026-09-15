import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";

type ExternalWindowOpener = (
  url?: string | URL,
  target?: string,
  features?: string,
) => WindowProxy | null;

export function openDiscoveredPortExternally(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly port: DiscoveredLocalServer;
  },
  openExternal: ExternalWindowOpener = window.open.bind(window),
): string {
  const resolvedUrl = resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  openExternal(resolvedUrl, "_blank", "noopener,noreferrer");
  return resolvedUrl;
}

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const resolvedUrl = resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: resolvedUrl,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
