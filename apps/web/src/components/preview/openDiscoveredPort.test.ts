import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { openDiscoveredPortExternally } from "./openDiscoveredPort";

const resolvedUrl = "http://fedora.example.ts.net:5173/dashboard";

vi.mock("~/browser/browserTargetResolver", () => ({
  resolveDiscoveredServerUrl: vi.fn(() => resolvedUrl),
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: vi.fn() }),
  },
}));

const threadRef = {
  environmentId: "remote-environment" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const port: DiscoveredLocalServer = {
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173/dashboard",
  processName: "vite",
  pid: 123,
  terminal: { threadId: threadRef.threadId, terminalId: "default" },
};

describe("openDiscoveredPortExternally", () => {
  it("opens the environment-resolved URL in a separate browser tab", () => {
    const openExternal = vi.fn(() => null);

    expect(openDiscoveredPortExternally({ threadRef, port }, openExternal)).toBe(resolvedUrl);
    expect(openExternal).toHaveBeenCalledWith(resolvedUrl, "_blank", "noopener,noreferrer");
  });
});
