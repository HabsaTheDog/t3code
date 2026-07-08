#!/usr/bin/env node

import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Action = "backup" | "restore" | "reset";

interface BackupManifestEntry {
  readonly source: string;
  readonly target: string;
}

interface BackupManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly entries: readonly BackupManifestEntry[];
}

const BACKUP_PREFIX = "t3code-backup-";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const T3_ROOT = path.resolve(SCRIPT_DIR, "..");
const STUDY_BUDDY_ROOT = path.resolve(T3_ROOT, "..");
const DEFAULT_STUDY_BUDDY_T3_HOME = path.join(
  STUDY_BUDDY_ROOT,
  "output",
  "t3-study-buddy-t3-home",
);
const DEFAULT_STUDY_BUDDY_T3_HOME_DEV = path.join(
  STUDY_BUDDY_ROOT,
  "output",
  "t3-study-buddy-t3-home-dev",
);

function getAppDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }

  return (
    process.env.APPDATA?.trim() ||
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(os.homedir(), ".config")
  );
}

function getStudyBuddyT3Home(): string {
  return path.resolve(process.env.STUDY_BUDDY_T3_HOME?.trim() || DEFAULT_STUDY_BUDDY_T3_HOME);
}

function includeSharedInstallState(): boolean {
  return process.env.STUDY_BUDDY_T3_INCLUDE_SHARED_INSTALL?.trim() === "1";
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry.trim())).filter((entry) => entry.length > 0))];
}

function studyBuddyStateRoots(): readonly string[] {
  return uniquePaths([
    getStudyBuddyT3Home(),
    DEFAULT_STUDY_BUDDY_T3_HOME,
    DEFAULT_STUDY_BUDDY_T3_HOME_DEV,
  ]);
}

function sharedInstallStateRoots(): readonly string[] {
  const appDataDir = getAppDataDir();

  return uniquePaths([
    path.join(os.homedir(), ".t3"),
    path.join(appDataDir, "t3code"),
    path.join(appDataDir, "t3code-dev"),
    path.join(appDataDir, "T3 Code (Alpha)"),
    path.join(appDataDir, "T3 Code (Dev)"),
  ]);
}

function candidateSources(): readonly string[] {
  return includeSharedInstallState()
    ? uniquePaths([...studyBuddyStateRoots(), ...sharedInstallStateRoots()])
    : studyBuddyStateRoots();
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupRoot(): string {
  return path.join(os.homedir(), `${BACKUP_PREFIX}${timestamp()}`);
}

function manifestPath(root: string): string {
  return path.join(root, "manifest.json");
}

function entryTargetName(source: string, index: number): string {
  return `${String(index).padStart(2, "0")}-${path.basename(source) || "root"}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sourceExists(source: string): Promise<boolean> {
  return exists(source);
}

async function loadManifest(root: string): Promise<BackupManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(root), "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

async function latestBackupRoot(): Promise<string | null> {
  const homeEntries = await readdir(os.homedir(), { withFileTypes: true });
  const candidates = homeEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .map((entry) => entry.name)
    .sort();

  if (candidates.length === 0) {
    return null;
  }

  return path.join(os.homedir(), candidates[candidates.length - 1]!);
}

async function backupInstall(): Promise<void> {
  const root = backupRoot();
  const entries: BackupManifestEntry[] = [];
  const sources = candidateSources();

  console.log(`Backing up to ${root}`);
  console.log(
    includeSharedInstallState()
      ? "Scope: Study Buddy fork state plus shared T3 Code install state."
      : "Scope: Study Buddy fork state only.",
  );
  for (const [index, source] of sources.entries()) {
    if (!(await sourceExists(source))) {
      continue;
    }

    const target = path.join("entries", entryTargetName(source, index));
    const destination = path.join(root, target);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
    entries.push({ source, target });
    console.log(`Saved ${source}`);
  }

  if (entries.length === 0) {
    console.log("No desktop install state was found.");
    return;
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries,
  };
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Backup complete: ${root}`);
}

async function restoreInstall(): Promise<void> {
  const root = await latestBackupRoot();
  if (!root) {
    throw new Error("No backup found.");
  }

  const manifest = await loadManifest(root);
  if (!manifest) {
    throw new Error(`Backup manifest is missing or invalid: ${root}`);
  }

  console.log(`Restoring from ${root}`);
  for (const entry of manifest.entries) {
    const source = path.join(root, entry.target);
    await rm(entry.source, { force: true, recursive: true });
    await mkdir(path.dirname(entry.source), { recursive: true });
    await cp(source, entry.source, { recursive: true, preserveTimestamps: true });
    console.log(`Restored ${entry.source}`);
  }

  console.log("Restore complete.");
}

async function resetInstall(): Promise<void> {
  console.log(
    includeSharedInstallState()
      ? "Resetting Study Buddy fork state plus shared T3 Code install state."
      : "Resetting Study Buddy fork state only.",
  );
  for (const source of candidateSources()) {
    await rm(source, { force: true, recursive: true });
  }
  console.log("Desktop install state reset.");
}

async function main(): Promise<void> {
  const action = (process.argv[2] ?? "").trim() as Action | "";

  switch (action) {
    case "backup":
      await backupInstall();
      break;
    case "restore":
      await restoreInstall();
      break;
    case "reset":
      await resetInstall();
      break;
    default:
      console.error(
        "Usage: node scripts/desktop-installation-state.ts <backup|restore|reset>\n"
          + "Defaults to Study Buddy fork state only. Set STUDY_BUDDY_T3_INCLUDE_SHARED_INSTALL=1 to include shared T3 Code install state.",
      );
      process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
