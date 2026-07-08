import { Codex } from "@openai/codex-sdk";
import type { MoodleRuntimeConfig } from "./types.ts";

export interface CodexClient {
  run(prompt: string, options?: { outputSchema?: unknown }): Promise<string>;
}

export function createCodexClient(config: MoodleRuntimeConfig): CodexClient {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: config.runDir,
    skipGitRepoCheck: true,
    ...(config.codexModel ? { model: config.codexModel } : {}),
  });

  return {
    async run(prompt, options) {
      const turn = await thread.run(prompt, options);
      return turn.finalResponse;
    },
  };
}
