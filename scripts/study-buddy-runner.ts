#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off - This small launcher runs before the Effect runtime and preserves child stdio.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeStudyBuddyHostEnvironment } from "./lib/study-buddy-environment.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const T3_ROOT = path.resolve(SCRIPT_DIR, "..");
const STUDY_BUDDY_ROOT = path.resolve(T3_ROOT, "..");
const DEFAULT_T3_HOME = path.join(STUDY_BUDDY_ROOT, "output", "t3-study-buddy-t3-home");
const DEFAULT_PORT_OFFSET = "120";

type CommandName = "ports" | "dev" | "dev:no-browser" | "app" | "moodle";

const command = (process.argv[2] ?? "help") as CommandName | "help";
const passthroughArgs = process.argv.slice(3);

const t3Home = path.resolve(process.env.STUDY_BUDDY_T3_HOME || DEFAULT_T3_HOME);

function ensureT3Home(): void {
  mkdirSync(t3Home, { recursive: true });
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandNames(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

function pathEntries(value: string | undefined): string[] {
  return (value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findCommandInPath(command: string, entries: string[]): string | null {
  for (const entry of entries) {
    for (const candidate of commandNames(command)) {
      const candidatePath = path.join(entry, candidate);
      if (isExecutable(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return null;
}

function isProjectLocalCodexPath(value: string): boolean {
  const normalized = path.normalize(value);
  return (
    normalized.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}codex`) ||
    normalized.startsWith(path.join(STUDY_BUDDY_ROOT, "node_modules")) ||
    normalized.startsWith(path.join(T3_ROOT, "node_modules"))
  );
}

function resolvePreferredCodexBinary(): string | null {
  const override = process.env.STUDY_BUDDY_CODEX_BINARY?.trim();
  if (override) {
    return override;
  }

  // The standalone installer maintains this stable launcher across CLI and
  // Node upgrades. Prefer it over version-bound npm/NVM installation paths.
  const fromStableUserBin = findCommandInPath("codex", [path.join(os.homedir(), ".local", "bin")]);
  if (fromStableUserBin && !isProjectLocalCodexPath(fromStableUserBin)) {
    return fromStableUserBin;
  }

  const nodeBinDir = path.dirname(process.execPath);
  const fromNodeBin = findCommandInPath("codex", [nodeBinDir]);
  if (fromNodeBin && !isProjectLocalCodexPath(fromNodeBin)) {
    return fromNodeBin;
  }

  const externalPathEntries = pathEntries(process.env.PATH).filter(
    (entry) =>
      !entry.includes(`${path.sep}node_modules${path.sep}.bin`) &&
      !entry.startsWith(path.join(STUDY_BUDDY_ROOT, "node_modules")) &&
      !entry.startsWith(path.join(T3_ROOT, "node_modules")),
  );
  return findCommandInPath("codex", externalPathEntries);
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUsePreferredCodexBinary(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return true;
  }
  const trimmed = value.trim();
  if (trimmed === "codex") {
    return true;
  }
  if (isProjectLocalCodexPath(trimmed)) {
    return true;
  }
  if (!hasPathSeparator(trimmed)) {
    return false;
  }
  const resolved = path.resolve(trimmed);
  return !isExecutable(resolved) || isProjectLocalCodexPath(resolved);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function seedCodexProviderBinary(): void {
  const preferredCodex = resolvePreferredCodexBinary();
  if (!preferredCodex) {
    return;
  }

  const settingsPath = path.join(t3Home, "dev", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8").trim();
      settings = raw.length > 0 ? asRecord(JSON.parse(raw)) : {};
    } catch {
      return;
    }
  }

  let changed = false;
  const providers = asRecord(settings.providers);
  const codexProvider = asRecord(providers.codex);
  if (shouldUsePreferredCodexBinary(codexProvider.binaryPath)) {
    codexProvider.binaryPath = preferredCodex;
    providers.codex = codexProvider;
    settings.providers = providers;
    changed = true;
  }

  const providerInstances = asRecord(settings.providerInstances);
  const codexInstance = asRecord(providerInstances.codex);
  if (codexInstance.driver === "codex") {
    const config = asRecord(codexInstance.config);
    if (shouldUsePreferredCodexBinary(config.binaryPath)) {
      config.binaryPath = preferredCodex;
      codexInstance.config = config;
      providerInstances.codex = codexInstance;
      settings.providerInstances = providerInstances;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function studyBuddyEnv(): NodeJS.ProcessEnv {
  // The direct Moodle CLI needs portal configuration from the caller. The UI,
  // server, desktop shell, and their provider children read credentials from
  // Study Buddy's owner-only configuration file instead and must never inherit
  // portal values through the host environment.
  const baseEnvironment =
    command === "moodle" ? { ...process.env } : sanitizeStudyBuddyHostEnvironment(process.env);
  return {
    ...baseEnvironment,
    T3CODE_PORT_OFFSET: process.env.T3CODE_PORT_OFFSET || DEFAULT_PORT_OFFSET,
    T3CODE_HOME: t3Home,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD:
      process.env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD || "0",
    STUDY_BUDDY_ROOT,
    STUDY_BUDDY_T3_ROOT: T3_ROOT,
  };
}

function runNode(args: string[]): never {
  ensureT3Home();
  seedCodexProviderBinary();
  if (command === "moodle" && !process.env.STUDY_BUDDY_WORKSPACE && !process.env.T3CODE_CWD) {
    console.error(
      "moodle:agent requires STUDY_BUDDY_WORKSPACE or T3CODE_CWD. UI Quick Chats and user-selected projects provide this automatically.",
    );
    process.exit(1);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: T3_ROOT,
    env: studyBuddyEnv(),
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

function printPaths(): void {
  console.log(`T3 local state: ${t3Home}`);
  console.log(`Quick Chat workspaces: ${path.join(t3Home, "quick-chats")}`);
  console.log("Project workspaces: user-selected T3 projects only");
}

switch (command) {
  case "ports":
    printPaths();
    runNode(["scripts/dev-runner.ts", "dev", "--dry-run"]);
    break;
  case "dev":
    printPaths();
    runNode(["scripts/dev-runner.ts", "dev"]);
    break;
  case "dev:no-browser":
    printPaths();
    runNode(["scripts/dev-runner.ts", "dev", "--no-browser"]);
    break;
  case "app":
    printPaths();
    runNode(["scripts/dev-runner.ts", "dev:desktop"]);
    break;
  case "moodle":
    runNode([
      path.join(STUDY_BUDDY_ROOT, "node_modules/tsx/dist/cli.mjs"),
      path.join(STUDY_BUDDY_ROOT, "src/custom-skills/moodle/cli.ts"),
      ...passthroughArgs,
    ]);
    break;
  default:
    console.error(
      "Usage: node scripts/study-buddy-runner.ts <ports|dev|dev:no-browser|app|moodle>",
    );
    process.exit(1);
}
