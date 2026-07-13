import { createAgentBrowserClient, type AgentBrowserClient } from "./agentBrowserClient.ts";
import { createPlaywrightBrowserClient } from "./playwrightBrowserClient.ts";
import type { MoodleRuntimeConfig } from "./types.ts";

export function createBrowserClient(config: MoodleRuntimeConfig): AgentBrowserClient {
  return config.browserBackend === "playwright"
    ? createPlaywrightBrowserClient(config)
    : createAgentBrowserClient(config);
}
