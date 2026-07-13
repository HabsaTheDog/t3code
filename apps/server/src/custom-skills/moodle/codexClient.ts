import { Codex } from "@openai/codex-sdk";
import type { MoodleRuntimeConfig } from "./types.ts";

export interface CodexClient {
  run(prompt: string, options?: { outputSchema?: unknown }): Promise<string>;
}

const CODEX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** The model subprocess receives operational values only, never Study Buddy secrets. */
export function buildCodexProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    CODEX_ENV_ALLOWLIST.flatMap((key) => {
      const value = source[key];
      return value ? [[key, value] as const] : [];
    }),
  );
}

export function createCodexClient(config: MoodleRuntimeConfig): CodexClient {
  const environment = buildCodexProcessEnvironment();
  const codex = new Codex({
    env: environment,
    config: {
      default_permissions: "study_buddy_analysis",
      shell_environment_policy: {
        inherit: "none",
        set: {
          PATH: environment.PATH ?? "",
          LANG: environment.LANG ?? "C.UTF-8",
        },
      },
      web_search: "disabled",
    },
  });
  const thread = codex.startThread({
    workingDirectory: config.runDir,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    ...(config.codexModel ? { model: config.codexModel } : {}),
  });

  return {
    async run(prompt, options) {
      const turn = await thread.run(prompt, options);
      return turn.finalResponse;
    },
  };
}
