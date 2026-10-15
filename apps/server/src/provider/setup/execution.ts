import { ClaudeSettings, type UnifiedSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ResolvedProviderSetupAction } from "./capabilities.ts";
import type { ProviderSetupExecution } from "./jobRunner.ts";
import { resolveDefaultProviderSetupConfig } from "./executionConfig.ts";
import {
  studyBuddyCodexEnvironment,
  type StudyBuddyCodexPolicyPaths,
} from "./studyBuddyCodexPolicy.ts";

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

// Resolve the command and account environment from one current settings
// snapshot, so discovery and login target the same default provider instance.
export const resolveProviderSetupExecution = Effect.fn("resolveProviderSetupExecution")(
  function* (input: {
    readonly action: ResolvedProviderSetupAction;
    readonly settings: Pick<UnifiedSettings, "providers" | "providerInstances">;
    readonly codexPaths: StudyBuddyCodexPolicyPaths;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const { instance, binaryPath, config } = resolveDefaultProviderSetupConfig(
      input.action.provider,
      input.settings,
    );
    const environment = studyBuddyCodexEnvironment(
      input.codexPaths,
      mergeProviderInstanceEnvironment(instance?.environment, input.environment),
    );
    const env =
      input.action.provider === "claude"
        ? yield* makeClaudeEnvironment(yield* decodeClaudeSettings(config), environment)
        : environment;
    return {
      command: input.action.kind === "install" ? input.action.executable : binaryPath,
      env,
    } satisfies ProviderSetupExecution;
  },
);
