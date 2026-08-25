// @effect-diagnostics nodeBuiltinImport:off
import os from "node:os";
import path from "node:path";

const UPSTREAM_T3_PORTS = new Set([3773, 3774]);

export interface StudyBuddyRuntimeIsolationInput {
  readonly t3Home: string;
  readonly serverPort?: number;
  readonly webPort?: number;
  readonly upstreamT3Home?: string;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertStudyBuddyRuntimeIsolation({
  t3Home,
  serverPort,
  webPort,
  upstreamT3Home = path.join(os.homedir(), ".t3"),
}: StudyBuddyRuntimeIsolationInput): void {
  const resolvedT3Home = path.resolve(t3Home);
  const resolvedUpstreamT3Home = path.resolve(upstreamT3Home);

  if (isPathWithin(resolvedT3Home, resolvedUpstreamT3Home)) {
    throw new Error(
      `Study Buddy refuses to use upstream T3 state at ${resolvedT3Home}. Choose a dedicated STUDY_BUDDY_T3_HOME outside ${resolvedUpstreamT3Home}.`,
    );
  }

  for (const [label, port] of [
    ["server", serverPort],
    ["web", webPort],
  ] as const) {
    if (port !== undefined && UPSTREAM_T3_PORTS.has(port)) {
      throw new Error(
        `Study Buddy refuses to use upstream T3 ${label} port ${port}. Choose a dedicated Study Buddy port.`,
      );
    }
  }
}
