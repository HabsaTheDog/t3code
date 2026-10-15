// @effect-diagnostics nodeBuiltinImport:off - synchronous setup discovery shares native runtime path resolution.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { mergePathValues } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export function resolveClaudeEnvironment(
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const resolvedHomePath = path.resolve(expandHomePath(homePath));
  const providerPath = mergePathValues(
    baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path,
    path.join(resolvedHomePath, ".local", "bin"),
    platform,
  );
  return {
    ...baseEnv,
    HOME: resolvedHomePath,
    // Native Claude installers write beneath HOME. Keep that executable
    // visible after installation while preserving explicit PATH precedence.
    PATH: providerPath,
  };
}

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(
  (config: Pick<ClaudeSettings, "homePath">, baseEnv: NodeJS.ProcessEnv = process.env) =>
    Effect.sync(() => resolveClaudeEnvironment(config, baseEnv)),
);

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);
