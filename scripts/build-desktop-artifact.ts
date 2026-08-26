#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import { fromYaml } from "@t3tools/shared/schemaYaml";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  readFile as nodeReadFile,
  readdir as nodeReadDirectory,
  realpath as nodeRealpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
const STUDY_BUDDY_APP_ID = "com.studybuddy.t3code";
const STUDY_BUDDY_EXECUTABLE_NAME = "study-buddy-t3code";
const STUDY_BUDDY_UPDATE_REPOSITORY = "HabsaTheDog/StudyBuddy";
const STUDY_BUDDY_SPEECH_VERSION = "0.1.0";
type DesktopUpdateChannel = "latest" | "alpha" | "beta" | "nightly";

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|nightly)(?:\.[0-9A-Za-z-]+)*)?$/;
const POSTHOG_PUBLIC_TOKEN_PATTERN = /^phc_[A-Za-z0-9_-]{10,}$/;
const POSTHOG_ADMIN_TOKEN_PATTERN = /\bphx_[A-Za-z0-9_-]{10,}\b/;
const REQUIRED_WORKFLOW_PATHS = [
  "package.json",
  "package-lock.json",
  "src/custom-skills/moodle/cli.ts",
  "src/custom-skills/web-layout/cli.ts",
  "src/custom-skills/interactive-study-guide/cli.ts",
  "src/shared/htmlSource.ts",
  "CI/logo.png",
  "scripts/study_buddy_task.sh",
] as const;
const RELEASE_ARTIFACT_DENYLIST = new Set(["builder-debug.yml", "builder-effective-config.yaml"]);

export function isDirectExecution(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && pathToFileURL(entryPath).href === moduleUrl;
}

export function normalizeBuildCliArgv(argv: readonly string[]): string[] {
  const normalized = [...argv];
  if (normalized[2] === "--") normalized.splice(2, 1);
  return normalized;
}

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const DesktopUpdateChannelSchema = Schema.Literals(["latest", "alpha", "beta", "nightly"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
  readonly workflowRoot: Option.Option<string>;
  readonly updateRepository: Option.Option<string>;
  readonly updateChannel: Option.Option<DesktopUpdateChannel>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return getDefaultBuildArch(platform, process.arch, process.env, config);
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && (yield* fs.exists(configured))) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if (yield* fs.exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
  readonly workflowRoot: string | undefined;
  readonly updateRepository: string | undefined;
  readonly updateChannel: DesktopUpdateChannel | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly desktopName: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
  readonly pnpm?: {
    readonly patchedDependencies?: Record<string, string>;
  };
}

interface WorkflowPackageJson {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface WorkflowPackageLock {
  readonly version?: string;
  readonly packages?: Record<
    string,
    { readonly version?: string; readonly dependencies?: Record<string, string> }
  >;
}

interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
}

export function resolveWorkflowRuntimeDependencies(
  packageJson: WorkflowPackageJson,
  packageLock: WorkflowPackageLock,
): Record<string, string> {
  const requested = packageJson.dependencies ?? {};
  if (!requested.tsx) {
    throw new Error("Canonical workflow must declare tsx as a production dependency.");
  }
  return Object.fromEntries(
    Object.keys(requested)
      .sort()
      .map((name) => {
        const lockedVersion = packageLock.packages?.[`node_modules/${name}`]?.version;
        if (!lockedVersion) {
          throw new Error(`Canonical workflow lockfile is missing ${name}.`);
        }
        return [name, lockedVersion];
      }),
  );
}

export function assertWorkflowReleaseIdentity(
  packageJson: WorkflowPackageJson,
  packageLock: WorkflowPackageLock,
): void {
  const workflowVersion = packageJson.version;
  if (!workflowVersion) {
    throw new Error("Canonical workflow package.json version is missing.");
  }
  if (
    packageLock.version !== workflowVersion ||
    packageLock.packages?.[""]?.version !== workflowVersion
  ) {
    throw new Error("Canonical workflow package-lock version does not match package.json.");
  }
  const packageDependencies = packageJson.dependencies ?? {};
  const lockedRootDependencies = packageLock.packages?.[""]?.dependencies ?? {};
  const sortedEntries = (value: Record<string, string>) =>
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  if (
    JSON.stringify(sortedEntries(packageDependencies)) !==
    JSON.stringify(sortedEntries(lockedRootDependencies))
  ) {
    throw new Error("Canonical workflow package.json and package-lock root dependencies differ.");
  }
  resolveWorkflowRuntimeDependencies(packageJson, packageLock);
}

export function assertReleasePublicConfiguration(input: {
  readonly mockUpdates: boolean;
  readonly environment: NodeJS.ProcessEnv;
}): string | undefined {
  if (input.mockUpdates) return undefined;
  const token = input.environment.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !POSTHOG_PUBLIC_TOKEN_PATTERN.test(token)) {
    throw new Error("Release builds require a valid public VITE_POSTHOG_PROJECT_TOKEN (phc_...).");
  }
  return token;
}

export function sanitizeReleaseBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (
      /POSTHOG/i.test(key) &&
      (/(?:PERSONAL|ADMIN)/i.test(key) || /API_KEY/i.test(key) || key === "POSTHOG_TOKEN")
    ) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

export function createDesktopCycloneDxSbom(input: {
  readonly appVersion: string;
  readonly packages: readonly InstalledPackage[];
}): Record<string, unknown> {
  const npmPurl = (name: string, version: string) => {
    const encodedName = name.startsWith("@")
      ? `%40${encodeURIComponent(name.slice(1).split("/")[0] ?? "")}/${encodeURIComponent(name.split("/")[1] ?? "")}`
      : encodeURIComponent(name);
    return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
  };
  const npmComponents = [...input.packages]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
    .map((entry) => ({
      type: "library",
      "bom-ref": npmPurl(entry.name, entry.version),
      name: entry.name,
      version: entry.version,
      purl: npmPurl(entry.name, entry.version),
      ...(entry.license ? { licenses: [{ license: { name: entry.license } }] } : {}),
    }));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:generic/study-buddy-desktop@${encodeURIComponent(input.appVersion)}`,
        name: "Study Buddy Desktop",
        version: input.appVersion,
      },
      properties: [
        { name: "study-buddy:browser-runtime", value: "system Edge, Chrome, or Chromium" },
      ],
    },
    components: [
      ...npmComponents,
      {
        type: "application",
        "bom-ref": `pkg:generic/study-buddy-workflow@${encodeURIComponent(input.appVersion)}`,
        name: "Study Buddy workflow runtime",
        version: input.appVersion,
        licenses: [{ license: { id: "MIT" } }],
      },
      {
        type: "framework",
        "bom-ref": `pkg:npm/electron@${encodeURIComponent(desktopPackageJson.dependencies.electron)}`,
        name: "Electron",
        version: desktopPackageJson.dependencies.electron,
        purl: `pkg:npm/electron@${encodeURIComponent(desktopPackageJson.dependencies.electron)}`,
        licenses: [{ license: { id: "MIT" } }],
      },
      {
        type: "application",
        "bom-ref": `pkg:cargo/study-buddy-speech@${STUDY_BUDDY_SPEECH_VERSION}`,
        name: "Study Buddy speech sidecar",
        version: STUDY_BUDDY_SPEECH_VERSION,
        purl: `pkg:cargo/study-buddy-speech@${STUDY_BUDDY_SPEECH_VERSION}`,
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
}

const readJsonFile = Effect.fn("readJsonFile")(function* <A>(filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath);
  return yield* Effect.try({
    try: () => JSON.parse(raw) as A,
    catch: (cause) =>
      new BuildScriptError({ message: `Could not parse JSON at ${filePath}.`, cause }),
  });
});

const resolveWorkflowRuntime = Effect.fn("resolveWorkflowRuntime")(function* (
  workflowRoot: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!workflowRoot) {
    return yield* new BuildScriptError({
      message: "Canonical Study Buddy workflow root was not configured.",
    });
  }
  const root = path.resolve(workflowRoot);
  for (const relativePath of REQUIRED_WORKFLOW_PATHS) {
    const absolutePath = path.join(root, relativePath);
    if (!(yield* fs.exists(absolutePath))) {
      return yield* new BuildScriptError({
        message: `Canonical Study Buddy workflow is incomplete: missing ${relativePath}.`,
      });
    }
  }
  const packageJson = yield* readJsonFile<WorkflowPackageJson>(path.join(root, "package.json"));
  const packageLock = yield* readJsonFile<WorkflowPackageLock>(
    path.join(root, "package-lock.json"),
  );
  yield* Effect.try({
    try: () => assertWorkflowReleaseIdentity(packageJson, packageLock),
    catch: (cause) =>
      new BuildScriptError({
        message: "Canonical Study Buddy workflow dependencies are not fully locked.",
        cause,
      }),
  });
  return { root } as const;
});

const PACKAGED_NPM_RUNNER = `import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root = process.env.STUDY_BUDDY_ROOT;
if (!root) throw new Error("STUDY_BUDDY_ROOT is required.");
const args = process.argv.slice(2);
if (args[0] !== "run" || !args[1]) throw new Error("Only npm run <script> is supported.");
const scriptName = args[1];
const forwarded = args.slice(args[2] === "--" ? 3 : 2);
const pkg = JSON.parse(await readFile(path.join(root, "canonical-package.json"), "utf8"));
const command = pkg.scripts?.[scriptName];
const match = typeof command === "string" ? command.match(/^tsx\\s+([^\\s]+)(?:\\s+(.*))?$/) : null;
if (!match?.[1]) throw new Error(\`Unsupported packaged Study Buddy script: \${scriptName}\`);
const staticArgs = match[2]?.trim().split(/\\s+/).filter(Boolean) ?? [];
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(root, match[1]);
const child = spawn(process.execPath, [tsx, entry, ...staticArgs, ...forwarded], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`;

const NODE_SHIM = `#!/usr/bin/env sh
set -eu
: "\${STUDY_BUDDY_NODE_EXECUTABLE:?STUDY_BUDDY_NODE_EXECUTABLE is required}"
ELECTRON_RUN_AS_NODE=1 exec "$STUDY_BUDDY_NODE_EXECUTABLE" "$@"
`;

const NPM_SHIM = `#!/usr/bin/env sh
set -eu
: "\${STUDY_BUDDY_NODE_EXECUTABLE:?STUDY_BUDDY_NODE_EXECUTABLE is required}"
: "\${STUDY_BUDDY_ROOT:?STUDY_BUDDY_ROOT is required}"
ELECTRON_RUN_AS_NODE=1 exec "$STUDY_BUDDY_NODE_EXECUTABLE" "$STUDY_BUDDY_ROOT/bin/npm-run.mjs" "$@"
`;

const PACKAGED_TASK_SHIM = `#!/usr/bin/env sh
set -eu
: "\${STUDY_BUDDY_NODE_EXECUTABLE:?STUDY_BUDDY_NODE_EXECUTABLE is required}"
: "\${STUDY_BUDDY_ROOT:?STUDY_BUDDY_ROOT is required}"
ELECTRON_RUN_AS_NODE=1 exec "$STUDY_BUDDY_NODE_EXECUTABLE" "$STUDY_BUDDY_ROOT/bin/study_buddy_task.mjs" "$@"
`;

const WINDOWS_TASK_WRAPPER = `@echo off
if "%STUDY_BUDDY_NODE_EXECUTABLE%"=="" (echo STUDY_BUDDY_NODE_EXECUTABLE is required. 1>&2 & exit /b 1)
if "%STUDY_BUDDY_ROOT%"=="" (echo STUDY_BUDDY_ROOT is required. 1>&2 & exit /b 1)
set ELECTRON_RUN_AS_NODE=1
"%STUDY_BUDDY_NODE_EXECUTABLE%" "%STUDY_BUDDY_ROOT%\\bin\\study_buddy_task.mjs" %*
`;

const WINDOWS_NODE_SHIM = `@echo off
if "%STUDY_BUDDY_NODE_EXECUTABLE%"=="" (echo STUDY_BUDDY_NODE_EXECUTABLE is required. 1>&2 & exit /b 1)
set ELECTRON_RUN_AS_NODE=1
"%STUDY_BUDDY_NODE_EXECUTABLE%" %*
`;

const WINDOWS_NPM_SHIM = `@echo off
if "%STUDY_BUDDY_NODE_EXECUTABLE%"=="" (echo STUDY_BUDDY_NODE_EXECUTABLE is required. 1>&2 & exit /b 1)
if "%STUDY_BUDDY_ROOT%"=="" (echo STUDY_BUDDY_ROOT is required. 1>&2 & exit /b 1)
set ELECTRON_RUN_AS_NODE=1
"%STUDY_BUDDY_NODE_EXECUTABLE%" "%STUDY_BUDDY_ROOT%\\bin\\npm-run.mjs" %*
`;

export function shouldPublishDesktopArtifact(entry: string): boolean {
  return !RELEASE_ARTIFACT_DENYLIST.has(entry);
}

export const stageWorkflowRuntime = Effect.fn("stageWorkflowRuntime")(function* (
  workflowRoot: string,
  stageRuntimeDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(stageRuntimeDir, "bin"), { recursive: true });
  yield* fs.copy(
    path.join(workflowRoot, "src/custom-skills"),
    path.join(stageRuntimeDir, "src/custom-skills"),
  );
  yield* fs.copy(path.join(workflowRoot, "src/shared"), path.join(stageRuntimeDir, "src/shared"));
  yield* fs.makeDirectory(path.join(stageRuntimeDir, "CI"), { recursive: true });
  yield* fs.copyFile(
    path.join(workflowRoot, "CI/logo.png"),
    path.join(stageRuntimeDir, "CI/logo.png"),
  );
  const studyBuilderDocs = path.join(workflowRoot, "docs/study-builder-vnext");
  if (yield* fs.exists(studyBuilderDocs)) {
    yield* fs.copy(studyBuilderDocs, path.join(stageRuntimeDir, "docs/study-builder-vnext"));
  }
  yield* fs.copyFile(
    path.join(workflowRoot, "package.json"),
    path.join(stageRuntimeDir, "canonical-package.json"),
  );
  yield* fs.copyFile(
    path.join(workflowRoot, "package.json"),
    path.join(stageRuntimeDir, "package.json"),
  );
  yield* fs.copyFile(
    path.join(workflowRoot, "package-lock.json"),
    path.join(stageRuntimeDir, "package-lock.json"),
  );
  yield* fs.copyFile(
    path.join(workflowRoot, "scripts/study_buddy_task.sh"),
    path.join(stageRuntimeDir, "bin/study_buddy_task.sh"),
  );
  yield* fs.copyFile(
    fileURLToPath(new URL("./study-buddy-packaged-task.mjs", import.meta.url)),
    path.join(stageRuntimeDir, "bin/study_buddy_task.mjs"),
  );
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/npm-run.mjs"), PACKAGED_NPM_RUNNER);
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/node"), NODE_SHIM);
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/npm"), NPM_SHIM);
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/node.cmd"), WINDOWS_NODE_SHIM);
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/npm.cmd"), WINDOWS_NPM_SHIM);
  yield* fs.writeFileString(path.join(stageRuntimeDir, "bin/study_buddy_task"), PACKAGED_TASK_SHIM);
  yield* fs.writeFileString(
    path.join(stageRuntimeDir, "bin/study_buddy_task.cmd"),
    WINDOWS_TASK_WRAPPER,
  );
  yield* Effect.all(
    ["study_buddy_task.sh", "study_buddy_task.mjs", "study_buddy_task", "node", "npm"].map((name) =>
      fs.chmod(path.join(stageRuntimeDir, "bin", name), 0o755),
    ),
  );
});

async function enqueueNodeModulesPackages(directory: string, queue: string[]): Promise<void> {
  for (const entry of await nodeReadDirectory(directory).catch(() => [])) {
    if (entry === ".bin" || entry === ".pnpm") continue;
    if (entry.startsWith("@")) {
      for (const scopedEntry of await nodeReadDirectory(path.join(directory, entry)).catch(
        () => [],
      )) {
        queue.push(path.join(directory, entry, scopedEntry));
      }
    } else {
      queue.push(path.join(directory, entry));
    }
  }
}

export async function collectInstalledPackages(
  nodeModulesRoots: readonly string[],
): Promise<InstalledPackage[]> {
  const packages = new Map<string, InstalledPackage>();
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const root of nodeModulesRoots) {
    await enqueueNodeModulesPackages(root, queue);
    for (const virtualPackage of await nodeReadDirectory(path.join(root, ".pnpm")).catch(
      () => [],
    )) {
      await enqueueNodeModulesPackages(
        path.join(root, ".pnpm", virtualPackage, "node_modules"),
        queue,
      );
    }
  }
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    const resolved = await nodeRealpath(candidate).catch(() => candidate);
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    try {
      const packageJson = JSON.parse(
        await nodeReadFile(path.join(resolved, "package.json"), "utf8"),
      ) as {
        name?: string;
        version?: string;
        license?: string;
        dependencies?: Record<string, string>;
      };
      if (!packageJson.name || !packageJson.version) continue;
      packages.set(`${packageJson.name}@${packageJson.version}`, {
        name: packageJson.name,
        version: packageJson.version,
        ...(typeof packageJson.license === "string" ? { license: packageJson.license } : {}),
      });
      for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
        queue.push(path.join(resolved, "node_modules", dependencyName));
      }
    } catch {
      // A non-package entry in node_modules is irrelevant to the SBOM.
    }
  }
  return [...packages.values()];
}

async function collectReleaseAssetText(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await nodeReadDirectory(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (/\.(?:html|js|mjs|cjs|map|ts|tsx|json|sh|cmd)$/i.test(entry.name)) {
        chunks.push(await nodeReadFile(absolutePath, "utf8"));
      }
    }
  };
  await visit(root);
  return chunks.join("\n");
}

export function createStagePnpmConfig(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): StagePackageJson["pnpm"] | undefined {
  const stagePatchedDependencies = Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );

  return Object.keys(stagePatchedDependencies).length > 0
    ? { patchedDependencies: stagePatchedDependencies }
    : undefined;
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  workflowRoot: Config.string("STUDY_BUDDY_WORKFLOW_ROOT").pipe(Config.option),
  updateRepository: Config.string("STUDY_BUDDY_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
  updateChannel: Config.schema(
    DesktopUpdateChannelSchema,
    "STUDY_BUDDY_DESKTOP_UPDATE_CHANNEL",
  ).pipe(Config.option),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (yield* resolveMockUpdateServerPort(Option.getOrUndefined(env.mockUpdateServerPort)).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message: "Invalid mock update server port.",
            cause,
          }),
      ),
    ));

  const workflowRoot =
    Option.getOrUndefined(input.workflowRoot) ?? Option.getOrUndefined(env.workflowRoot);
  const updateRepository =
    Option.getOrUndefined(input.updateRepository) ?? Option.getOrUndefined(env.updateRepository);
  const updateChannel =
    Option.getOrUndefined(input.updateChannel) ?? Option.getOrUndefined(env.updateChannel);
  const expectedUpdateChannel = version ? resolveDesktopUpdateChannel(version) : undefined;

  if (!mockUpdates) {
    if (!version || !RELEASE_VERSION_PATTERN.test(version)) {
      return yield* new BuildScriptError({
        message: "Release builds require an explicit semantic --build-version.",
      });
    }
    if (!workflowRoot?.trim()) {
      return yield* new BuildScriptError({
        message: "Release builds require an explicit STUDY_BUDDY_WORKFLOW_ROOT.",
      });
    }
    if (!updateRepository?.trim() || !updateChannel) {
      return yield* new BuildScriptError({
        message:
          "Release builds require explicit Study Buddy update repository and channel settings.",
      });
    }
    if (
      !resolveGitHubPublishConfig(updateRepository, updateChannel) ||
      updateRepository.trim().toLowerCase() === "pingdotgg/t3code"
    ) {
      return yield* new BuildScriptError({
        message: "Configured updater repository is not a valid Study Buddy owner/repository.",
      });
    }
    if (updateChannel !== expectedUpdateChannel) {
      return yield* new BuildScriptError({
        message: `Configured update channel '${updateChannel}' does not match version channel '${expectedUpdateChannel}'.`,
      });
    }
  }

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
    workflowRoot: workflowRoot?.trim() || undefined,
    updateRepository: updateRepository?.trim() || undefined,
    updateChannel,
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label?: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    const outputSections = [
      options.label ? `Command: ${options.label}` : undefined,
      formatOutputSection("stdout", stdout),
      formatOutputSection("stderr", stderr),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})${outputSuffix}`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
      label: "iconutil icns",
      verbose,
    });
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop macOS icon source is missing at ${sourcePng}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop Linux icon source is missing at ${sourcePng}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });
    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch(() =>
      resize("convert").pipe(
        Effect.mapError(
          () =>
            new BuildScriptError({
              message:
                "ImageMagick is required to generate Linux desktop icon sizes. Install ImageMagick so either `magick` or `convert` is available.",
            }),
        ),
      ),
    ),
  );
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new BuildScriptError({
        message: `Desktop Windows icon source is missing at ${sourceIco}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

export function resolveGitHubPublishConfig(
  rawRepository: string,
  updateChannel: DesktopUpdateChannel,
):
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release" | "prerelease";
      readonly channel?: Exclude<DesktopUpdateChannel, "latest">;
    }
  | undefined {
  const [owner, repo, ...rest] = rawRepository.trim().split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "latest" ? "release" : "prerelease",
    ...(updateChannel === "latest" ? {} : { channel: updateChannel }),
  };
}

export function resolveDesktopUpdateChannel(version: string): DesktopUpdateChannel {
  const match = version.match(/-(alpha|beta|nightly)(?:\.|$)/);
  return match?.[1] === "alpha" || match?.[1] === "beta" || match?.[1] === "nightly"
    ? match[1]
    : "latest";
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

export function resolveDesktopProductName(version: string): string {
  const channel = resolveDesktopUpdateChannel(version);
  if (channel === "latest") return desktopPackageJson.productName ?? "Study Buddy";
  return `Study Buddy (${channel[0]!.toUpperCase()}${channel.slice(1)})`;
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  updateRepository = STUDY_BUDDY_UPDATE_REPOSITORY,
  configuredUpdateChannel?: DesktopUpdateChannel,
) {
  const buildConfig: Record<string, unknown> = {
    appId: STUDY_BUDDY_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: "Study-Buddy-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    extraResources: [
      {
        from: "apps/desktop/native/speech-sidecar/target/release",
        to: "speech-sidecar",
        filter: ["study-buddy-speech", "study-buddy-speech.exe"],
      },
      {
        from: "study-buddy-runtime",
        to: "study-buddy-runtime",
        filter: ["**/*", "!node_modules/**"],
      },
      {
        // electron-builder excludes nested node_modules from generic resources by default.
        // Rooting this FileSet at node_modules makes the locked workflow runtime explicit.
        from: "study-buddy-runtime/node_modules",
        to: "study-buddy-runtime/node_modules",
        filter: ["**/*"],
      },
    ],
    files: ["**/*", "!study-buddy-runtime/**"],
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  if (configuredUpdateChannel && configuredUpdateChannel !== updateChannel) {
    return yield* new BuildScriptError({
      message: `Configured update channel '${configuredUpdateChannel}' does not match '${updateChannel}'.`,
    });
  }
  if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: resolveMockUpdateServerUrl(mockUpdateServerPort),
      },
    ];
  } else {
    const publishConfig = resolveGitHubPublishConfig(updateRepository, updateChannel);
    if (!publishConfig) {
      return yield* new BuildScriptError({
        message: "Study Buddy update repository must use owner/repository syntax.",
      });
    }
    buildConfig.publish = [publishConfig];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        NSMicrophoneUsageDescription:
          "Study Buddy uses the microphone only to transcribe voice messages locally.",
      },
      protocols: [
        {
          name: "Study Buddy",
          schemes: [STUDY_BUDDY_EXECUTABLE_NAME],
        },
      ],
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      executableName: STUDY_BUDDY_EXECUTABLE_NAME,
      syncDesktopName: true,
      icon: "icons",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: STUDY_BUDDY_EXECUTABLE_NAME,
        },
      },
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    } else {
      // Keep resedit enabled so unsigned builds still embed the Study Buddy icon and metadata.
      // This disables only Authenticode signing; it does not require a certificate.
      winConfig.signExecutable = false;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const appVersion = options.version ?? serverPackageJson.version;
  const publicPostHogToken = yield* Effect.try({
    try: () =>
      assertReleasePublicConfiguration({
        mockUpdates: options.mockUpdates,
        environment: process.env,
      }),
    catch: (cause) =>
      new BuildScriptError({ message: "Release public configuration is incomplete.", cause }),
  });
  const workflow = yield* resolveWorkflowRuntime(options.workflowRoot);

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve overrides from pnpm-workspace.yaml.",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");
  const releaseBuildEnvironment = sanitizeReleaseBuildEnvironment({
    ...process.env,
    APP_VERSION: appVersion,
    ...(publicPostHogToken ? { VITE_POSTHOG_PROJECT_TOKEN: publicPostHogToken } : {}),
  });

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        env: releaseBuildEnvironment,
        // Windows needs shell mode to resolve .cmd shims (e.g. vp.cmd).
        shell: process.platform === "win32",
      })`vp run build:desktop`,
      { label: "vp run build:desktop", verbose: options.verbose },
    );
    yield* Effect.log("[desktop-artifact] Building local speech sidecar...");
    yield* runCommand(
      ChildProcess.make({
        cwd: path.join(repoRoot, "apps/desktop/native/speech-sidecar"),
        shell: process.platform === "win32",
      })`cargo build --release`,
      { label: "cargo build --release (speech sidecar)", verbose: options.verbose },
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'vp run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'vp run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));
  const releaseAssetText = yield* Effect.tryPromise({
    try: () => collectReleaseAssetText(path.dirname(bundledClientEntry)),
    catch: (cause) =>
      new BuildScriptError({ message: "Could not inspect bundled renderer assets.", cause }),
  });
  const completeReleaseCodeText = yield* Effect.tryPromise({
    try: async () =>
      (
        await Promise.all([
          collectReleaseAssetText(distDirs.desktopDist),
          collectReleaseAssetText(distDirs.serverDist),
        ])
      ).join("\n"),
    catch: (cause) =>
      new BuildScriptError({ message: "Could not inspect complete desktop release code.", cause }),
  });
  if (!releaseAssetText.includes(appVersion)) {
    return yield* new BuildScriptError({
      message: "Bundled renderer does not contain the requested release version.",
    });
  }
  if (publicPostHogToken && !releaseAssetText.includes(publicPostHogToken)) {
    return yield* new BuildScriptError({
      message: "Bundled renderer does not contain the configured public PostHog project token.",
    });
  }
  if (POSTHOG_ADMIN_TOKEN_PATTERN.test(completeReleaseCodeText)) {
    return yield* new BuildScriptError({
      message: "Bundled renderer contains a forbidden PostHog personal/admin token.",
    });
  }

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  const stageWorkflowRuntimeDir = path.join(stageAppDir, "study-buddy-runtime");
  yield* stageWorkflowRuntime(workflow.root, stageWorkflowRuntimeDir);
  const stagedWorkflowText = yield* Effect.tryPromise({
    try: () => collectReleaseAssetText(stageWorkflowRuntimeDir),
    catch: (cause) =>
      new BuildScriptError({ message: "Could not inspect staged Study Buddy workflow.", cause }),
  });
  if (POSTHOG_ADMIN_TOKEN_PATTERN.test(stagedWorkflowText)) {
    return yield* new BuildScriptError({
      message: "Staged Study Buddy workflow contains a forbidden PostHog personal/admin token.",
    });
  }
  const speechSidecarFile =
    process.platform === "win32" ? "study-buddy-speech.exe" : "study-buddy-speech";
  const speechSidecarSource = path.join(
    repoRoot,
    "apps/desktop/native/speech-sidecar/target/release",
    speechSidecarFile,
  );
  if (!(yield* fs.exists(speechSidecarSource))) {
    return yield* new BuildScriptError({
      message: `Missing speech sidecar at ${speechSidecarSource}. Run 'cargo build --release' in apps/desktop/native/speech-sidecar first.`,
    });
  }
  const stagedSpeechSidecarDir = path.join(
    stageAppDir,
    "apps/desktop/native/speech-sidecar/target/release",
  );
  yield* fs.makeDirectory(stagedSpeechSidecarDir, { recursive: true });
  yield* fs.copyFile(speechSidecarSource, path.join(stagedSpeechSidecarDir, speechSidecarFile));

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const stageDependencies = {
    ...resolvedServerDependencies,
    ...resolvedDesktopRuntimeDependencies,
  };
  const stagePnpmConfig = createStagePnpmConfig(workspacePatchedDependencies, stageDependencies);
  const stagePackageJson: StagePackageJson = {
    name: STUDY_BUDDY_EXECUTABLE_NAME,
    desktopName: STUDY_BUDDY_EXECUTABLE_NAME,
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: "Study Buddy desktop build",
    author: "Study Buddy",
    main: "apps/desktop/dist-electron/main.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      options.updateRepository ?? STUDY_BUDDY_UPDATE_REPOSITORY,
      options.updateChannel,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
    overrides: resolvedOverrides,
    ...(stagePnpmConfig ? { pnpm: stagePnpmConfig } : {}),
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  if (Object.keys(workspacePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: releaseBuildEnvironment,
      // Windows needs shell mode to resolve .cmd shims (e.g. vp.cmd).
      shell: process.platform === "win32",
    })`vp install --prod --no-optional`,
    { label: "vp install --prod --no-optional", verbose: options.verbose },
  );

  yield* Effect.log("[desktop-artifact] Installing packaged Study Buddy workflow dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageWorkflowRuntimeDir,
      env: releaseBuildEnvironment,
      shell: process.platform === "win32",
    })`npm ci --omit=dev --ignore-scripts`,
    {
      label: "npm ci --omit=dev --ignore-scripts (Study Buddy workflow)",
      verbose: options.verbose,
    },
  );

  const buildEnv: NodeJS.ProcessEnv = { ...releaseBuildEnvironment };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (process.platform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.verbose) {
    buildEnv.DEBUG =
      buildEnv.DEBUG === undefined || buildEnv.DEBUG === ""
        ? "electron-builder,electron-builder:*"
        : `${buildEnv.DEBUG},electron-builder,electron-builder:*`;
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: repoRoot,
      env: buildEnv,
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    })`vp exec --filter @t3tools/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
    {
      label: `vp exec --filter @t3tools/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const installedPackages = yield* Effect.tryPromise({
    try: () =>
      collectInstalledPackages([
        path.join(stageAppDir, "node_modules"),
        path.join(stageWorkflowRuntimeDir, "node_modules"),
      ]),
    catch: (cause) =>
      new BuildScriptError({ message: "Could not inventory staged dependencies for SBOM.", cause }),
  });
  if (installedPackages.length === 0) {
    return yield* new BuildScriptError({
      message: "Refusing to publish an empty desktop dependency SBOM.",
    });
  }
  const sbom = createDesktopCycloneDxSbom({ appVersion, packages: installedPackages });
  yield* fs.writeFileString(
    path.join(stageDistDir, "study-buddy-desktop.cdx.json"),
    `${JSON.stringify(sbom, null, 2)}\n`,
  );

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    if (!shouldPublishDesktopArtifact(entry)) continue;
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  workflowRoot: Flag.string("workflow-root").pipe(
    Flag.withDescription("Canonical Study Buddy workflow root (env: STUDY_BUDDY_WORKFLOW_ROOT)."),
    Flag.optional,
  ),
  updateRepository: Flag.string("update-repository").pipe(
    Flag.withDescription(
      "Explicit Study Buddy owner/repository update source (env: STUDY_BUDDY_DESKTOP_UPDATE_REPOSITORY).",
    ),
    Flag.optional,
  ),
  updateChannel: Flag.choice("update-channel", DesktopUpdateChannelSchema.literals).pipe(
    Flag.withDescription(
      "Explicit updater channel matching the version (env: STUDY_BUDDY_DESKTOP_UPDATE_CHANNEL).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a Study Buddy desktop artifact."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main || isDirectExecution(import.meta.url, process.argv[1])) {
  process.argv = normalizeBuildCliArgv(process.argv);
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
