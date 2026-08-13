// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off - This release gate must report before an Effect runtime exists.
import { spawnSync } from "node:child_process";

interface AuditFinding {
  paths?: string[];
}

interface AuditAdvisory {
  module_name?: string;
  severity?: string;
  title?: string;
  findings?: AuditFinding[];
}

interface AuditReport {
  advisories?: Record<string, AuditAdvisory>;
}

const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
const git = process.platform === "win32" ? "git.exe" : "git";
const trackedFiles = spawnSync(git, ["ls-files", "--stage"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (trackedFiles.status !== 0) {
  process.stderr.write(trackedFiles.stderr || "git ls-files could not inspect the release tree.\n");
  process.exit(trackedFiles.status ?? 1);
}

const embeddedGitlinks = trackedFiles.stdout.split(/\r?\n/).flatMap((entry) => {
  const match = /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(entry);
  return match?.[1] ? [match[1]] : [];
});

if (embeddedGitlinks.length > 0) {
  console.error("Study Buddy release tree contains undeclared embedded Git links:");
  for (const gitlink of embeddedGitlinks) console.error(`- ${gitlink}`);
  console.error(
    "Vendor reference source as ordinary files or declare an intentional submodule explicitly.",
  );
  process.exit(1);
}

const result = spawnSync(corepack, ["pnpm", "audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (!result.stdout.trim()) {
  process.stderr.write(result.stderr || "pnpm audit returned no JSON report.\n");
  process.exit(result.status ?? 1);
}

let report: AuditReport;
try {
  report = JSON.parse(result.stdout) as AuditReport;
} catch (error) {
  console.error(
    `Could not parse pnpm audit output: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const blockers: Array<{ moduleName: string; severity: string; title: string; path: string }> = [];
for (const advisory of Object.values(report.advisories ?? {})) {
  const severity = advisory.severity ?? "unknown";
  if (severity !== "high" && severity !== "critical") continue;
  for (const finding of advisory.findings ?? []) {
    for (const dependencyPath of finding.paths ?? []) {
      blockers.push({
        moduleName: advisory.module_name ?? "unknown-package",
        severity,
        title: advisory.title ?? "Untitled advisory",
        path: dependencyPath,
      });
    }
  }
}

if (blockers.length > 0) {
  console.error("Study Buddy release dependency audit failed:");
  for (const blocker of blockers) {
    console.error(
      `- [${blocker.severity}] ${blocker.moduleName}: ${blocker.title} (${blocker.path})`,
    );
  }
  process.exit(1);
}

console.log("Study Buddy workspace audit passed; no high/critical findings.");
