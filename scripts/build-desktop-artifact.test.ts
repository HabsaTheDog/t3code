import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { fileURLToPath } from "node:url";

import {
  createBuildConfig,
  createDesktopCycloneDxSbom,
  createStagePnpmConfig,
  assertReleasePublicConfiguration,
  assertWorkflowReleaseIdentity,
  collectInstalledPackages,
  isDirectExecution,
  normalizeBuildCliArgv,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolveWorkflowRuntimeDependencies,
  sanitizeReleaseBuildEnvironment,
  shouldPublishDesktopArtifact,
  stageWorkflowRuntime,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("detects direct execution on Node versions without import.meta.main", () => {
    assert.isTrue(isDirectExecution(import.meta.url, fileURLToPath(import.meta.url)));
    assert.isFalse(isDirectExecution(import.meta.url, undefined));
    assert.isFalse(isDirectExecution(import.meta.url, "/tmp/a-different-script.ts"));
  });

  it("strips the pnpm argument separator so Node 22 executes requested CLI flags", () => {
    assert.deepStrictEqual(
      normalizeBuildCliArgv(["node", "build-desktop-artifact.ts", "--", "--help"]),
      ["node", "build-desktop-artifact.ts", "--help"],
    );
    assert.deepStrictEqual(
      normalizeBuildCliArgv(["node", "build-desktop-artifact.ts", "--platform", "linux"]),
      ["node", "build-desktop-artifact.ts", "--platform", "linux"],
    );
  });

  it("keeps packaged extract routing and watchdog arguments aligned with the canonical wrapper", async () => {
    // The packaged adapter intentionally remains plain ESM so Electron can execute it without a loader.
    // @ts-expect-error The standalone release adapter has no TypeScript declaration file.
    const adapter = await import("./study-buddy-packaged-task.mjs");
    assert.deepStrictEqual(adapter.extractSourceArgsFor("Prüfungstermin morgen"), [
      "--cis-url",
      "https://cis.technikum-wien.at/cis.php/",
    ]);
    assert.deepStrictEqual(adapter.extractSourceArgsFor("Erkläre den Regelkreis"), ["--no-cis"]);
    assert.deepStrictEqual(adapter.watchdogArguments("/tmp/run", 42, {}), [
      "--run-dir",
      "/tmp/run",
      "--pid",
      "42",
      "--process-group-id",
      "42",
      "--idle-timeout-ms",
      "360000",
      "--max-runtime-ms",
      "5400000",
    ]);
  });

  it("requires only a public PostHog token and strips admin credentials from child builds", () => {
    assert.equal(
      assertReleasePublicConfiguration({
        mockUpdates: false,
        environment: { VITE_POSTHOG_PROJECT_TOKEN: "phc_public_project_token_123" },
      }),
      "phc_public_project_token_123",
    );
    assert.throws(() => assertReleasePublicConfiguration({ mockUpdates: false, environment: {} }));
    assert.deepStrictEqual(
      sanitizeReleaseBuildEnvironment({
        VITE_POSTHOG_PROJECT_TOKEN: "phc_public_project_token_123",
        POSTHOG_PERSONAL_API_KEY: "phx_private_admin_token_123",
        POSTHOG_API_KEY: "phx_private_admin_token_456",
      }),
      { VITE_POSTHOG_PROJECT_TOKEN: "phc_public_project_token_123" },
    );
  });

  it("locks canonical workflow runtime dependencies including tsx", () => {
    assert.deepStrictEqual(
      resolveWorkflowRuntimeDependencies(
        { dependencies: { playwright: "^1.62.1", tsx: "^4.23.12" } },
        {
          packages: {
            "node_modules/playwright": { version: "1.62.1" },
            "node_modules/tsx": { version: "4.23.12" },
          },
        },
      ),
      { playwright: "1.62.1", tsx: "4.23.12" },
    );
    assert.throws(() =>
      resolveWorkflowRuntimeDependencies(
        { dependencies: { playwright: "^1.62.1" }, devDependencies: { tsx: "^4.23.12" } },
        {
          packages: {
            "node_modules/playwright": { version: "1.62.1" },
            "node_modules/tsx": { version: "4.23.12" },
          },
        },
      ),
    );
  });

  it("requires canonical workflow package and lock identity to match each other", () => {
    const packageJson = { version: "1.0.0", dependencies: { tsx: "^4.23.12" } };
    const packageLock = {
      version: "1.0.0",
      packages: {
        "": { version: "1.0.0", dependencies: { tsx: "^4.23.12" } },
        "node_modules/tsx": { version: "4.23.12" },
      },
    };
    assert.doesNotThrow(() => assertWorkflowReleaseIdentity(packageJson, packageLock));
    assert.throws(() =>
      assertWorkflowReleaseIdentity({ dependencies: packageJson.dependencies }, packageLock),
    );
    assert.throws(() =>
      assertWorkflowReleaseIdentity(packageJson, {
        ...packageLock,
        packages: {
          ...packageLock.packages,
          "": { version: "1.0.0", dependencies: { tsx: "4.0.0" } },
        },
      }),
    );
  });

  it("creates a deterministic non-empty CycloneDX desktop SBOM", () => {
    const input = {
      appVersion: "1.0.0",
      packages: [
        { name: "zod", version: "4.4.3", license: "MIT" },
        { name: "effect", version: "4.0.0-beta.73", license: "MIT" },
      ],
    } as const;
    const first = JSON.stringify(createDesktopCycloneDxSbom(input));
    const second = JSON.stringify(createDesktopCycloneDxSbom(input));
    assert.equal(first, second);
    assert.include(first, "CycloneDX");
    assert.include(first, "study-buddy-speech");
    assert.include(first, "pkg:npm/effect");
  });

  it.effect("inventories transitive packages stored in pnpm's virtual store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "study-buddy-sbom-pnpm-" });
      const direct = path.join(temp, "node_modules/direct");
      const transitive = path.join(
        temp,
        "node_modules/.pnpm/transitive@2.0.0/node_modules/transitive",
      );
      yield* fs.makeDirectory(direct, { recursive: true });
      yield* fs.makeDirectory(transitive, { recursive: true });
      yield* fs.writeFileString(
        path.join(direct, "package.json"),
        '{"name":"direct","version":"1.0.0"}\n',
      );
      yield* fs.writeFileString(
        path.join(transitive, "package.json"),
        '{"name":"transitive","version":"2.0.0","license":"MIT"}\n',
      );

      assert.deepStrictEqual(
        (yield* Effect.promise(() =>
          collectInstalledPackages([path.join(temp, "node_modules")]),
        )).sort((a, b) => a.name.localeCompare(b.name)),
        [
          { name: "direct", version: "1.0.0" },
          { name: "transitive", version: "2.0.0", license: "MIT" },
        ],
      );
    }),
  );

  it.effect("stages a self-contained workflow tree without copying root secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "study-buddy-runtime-stage-" });
      const source = path.join(temp, "source");
      const stage = path.join(temp, "stage");
      yield* fs.makeDirectory(path.join(source, "src/custom-skills/moodle"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "src/shared"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "CI"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "scripts"), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "src/custom-skills/moodle/cli.ts"),
        "export {};\n",
      );
      yield* fs.writeFileString(path.join(source, "src/shared/htmlSource.ts"), "export {};\n");
      yield* fs.writeFileString(path.join(source, "CI/logo.png"), "png");
      yield* fs.writeFileString(
        path.join(source, "package.json"),
        '{"scripts":{"moodle:agent":"tsx src/custom-skills/moodle/cli.ts"},"dependencies":{"tsx":"4.23.12"}}\n',
      );
      yield* fs.writeFileString(
        path.join(source, "package-lock.json"),
        '{"lockfileVersion":3,"packages":{"":{"dependencies":{"tsx":"4.23.12"}},"node_modules/tsx":{"version":"4.23.12"}}}\n',
      );
      yield* fs.writeFileString(path.join(source, "scripts/study_buddy_task.sh"), "#!/bin/sh\n");
      yield* fs.writeFileString(path.join(source, ".env.local"), "SECRET=must-not-ship\n");

      yield* stageWorkflowRuntime(source, stage);

      assert.isTrue(yield* fs.exists(path.join(stage, "src/custom-skills/moodle/cli.ts")));
      assert.isTrue(yield* fs.exists(path.join(stage, "src/shared/htmlSource.ts")));
      assert.isTrue(yield* fs.exists(path.join(stage, "CI/logo.png")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/study_buddy_task.sh")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/study_buddy_task.mjs")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/study_buddy_task")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/study_buddy_task.cmd")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/node.cmd")));
      assert.isTrue(yield* fs.exists(path.join(stage, "bin/npm.cmd")));
      const windowsTaskWrapper = yield* fs.readFileString(
        path.join(stage, "bin/study_buddy_task.cmd"),
      );
      assert.notInclude(windowsTaskWrapper.toLowerCase(), "bash");
      assert.notInclude(windowsTaskWrapper.toLowerCase(), "wsl");
      assert.include(windowsTaskWrapper, "study_buddy_task.mjs");
      assert.include(
        yield* fs.readFileString(path.join(stage, "bin/study_buddy_task.mjs")),
        'from "node:child_process"',
      );
      assert.include(
        yield* fs.readFileString(path.join(stage, "bin/node")),
        "ELECTRON_RUN_AS_NODE",
      );
      assert.notInclude(
        (yield* fs.readFileString(path.join(stage, "bin/npm.cmd"))).toLowerCase(),
        "bash",
      );
      assert.include(yield* fs.readFileString(path.join(stage, "package.json")), '"tsx":"4.23.12"');
      assert.equal(
        yield* fs.readFileString(path.join(stage, "package-lock.json")),
        yield* fs.readFileString(path.join(source, "package-lock.json")),
      );
      assert.isFalse(yield* fs.exists(path.join(stage, ".env.local")));
    }),
  );

  it("excludes electron-builder diagnostics from published release assets", () => {
    assert.isFalse(shouldPublishDesktopArtifact("builder-debug.yml"));
    assert.isFalse(shouldPublishDesktopArtifact("builder-effective-config.yaml"));
    assert.isTrue(shouldPublishDesktopArtifact("study-buddy-desktop.cdx.json"));
    assert.isTrue(shouldPublishDesktopArtifact("Study-Buddy-1.0.0-x64.exe"));
  });

  it("resolves stable and prerelease updater channels from semantic versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.1.0-alpha.1"), "alpha");
    assert.equal(resolveDesktopUpdateChannel("0.1.0-beta.2"), "beta");
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("keeps Study Buddy branding and identifies prerelease builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Study Buddy");
    assert.equal(resolveDesktopProductName("0.1.0-alpha.1"), "Study Buddy (Alpha)");
    assert.equal(resolveDesktopProductName("0.1.0-beta.2"), "Study Buddy (Beta)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Study Buddy (Nightly)");
  });

  it.effect("uses Study Buddy-only desktop packaging identity", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("linux", "AppImage", "0.0.17", false, false, 3000);
      const linuxConfig = config.linux as
        | {
            readonly executableName?: string;
            readonly syncDesktopName?: boolean;
            readonly desktop?: { readonly entry?: { readonly StartupWMClass?: string } };
          }
        | undefined;

      assert.equal(config.appId, "com.studybuddy.t3code");
      assert.equal(config.artifactName, "Study-Buddy-${version}-${arch}.${ext}");
      assert.deepStrictEqual(config.publish, [
        {
          provider: "github",
          owner: "HabsaTheDog",
          repo: "StudyBuddy",
          releaseType: "release",
        },
      ]);
      assert.deepStrictEqual(config.extraResources, [
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
          from: "study-buddy-runtime/node_modules",
          to: "study-buddy-runtime/node_modules",
          filter: ["**/*"],
        },
      ]);
      assert.equal(linuxConfig?.executableName, "study-buddy-t3code");
      assert.isTrue(linuxConfig?.syncDesktopName);
      assert.equal(linuxConfig?.desktop?.entry?.StartupWMClass, "study-buddy-t3code");
    }),
  );

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.match(BRAND_ASSET_PATHS.productionWindowsIconIco, /study-buddy-windows\.ico$/);
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it.effect("keeps Windows resource editing enabled for unsigned builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("win", "nsis", "0.1.0-alpha.2", false, false, 3000);
      const win = config.win as
        | {
            readonly icon?: string;
            readonly signExecutable?: boolean;
            readonly signAndEditExecutable?: boolean;
          }
        | undefined;

      assert.equal(win?.icon, "icon.ico");
      assert.isFalse(win?.signExecutable);
      assert.isUndefined(win?.signAndEditExecutable);
    }),
  );

  it.effect("publishes alpha metadata to the alpha GitHub prerelease channel", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "linux",
        "AppImage",
        "0.1.0-alpha.1",
        false,
        false,
        3000,
      );
      assert.deepStrictEqual(config.publish, [
        {
          provider: "github",
          owner: "HabsaTheDog",
          repo: "StudyBuddy",
          releaseType: "prerelease",
          channel: "alpha",
        },
      ]);
    }),
  );

  it.effect("keeps beta and stable builds on their matching updater channels", () =>
    Effect.gen(function* () {
      const beta = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.0.0-beta.2",
        false,
        false,
        3000,
        "HabsaTheDog/StudyBuddy",
        "beta",
      );
      const stable = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.0.0",
        false,
        false,
        3000,
        "HabsaTheDog/StudyBuddy",
        "latest",
      );
      assert.deepStrictEqual(beta.publish, [
        {
          provider: "github",
          owner: "HabsaTheDog",
          repo: "StudyBuddy",
          releaseType: "prerelease",
          channel: "beta",
        },
      ]);
      assert.deepStrictEqual(stable.publish, [
        {
          provider: "github",
          owner: "HabsaTheDog",
          repo: "StudyBuddy",
          releaseType: "release",
        },
      ]);
    }),
  );

  it.effect("uses the local generic feed for explicit updater simulations", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "linux",
        "AppImage",
        "0.1.0-alpha.1",
        false,
        true,
        34567,
      );
      assert.deepStrictEqual(config.publish, [
        {
          provider: "generic",
          url: "http://localhost:34567",
        },
      ]);
    }),
  );

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        patchedDependencies: {
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
      },
    );

    assert.equal(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      undefined,
    );
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        workflowRoot: Option.none(),
        updateRepository: Option.none(),
        updateChannel: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
                T3CODE_DESKTOP_VERSION: "1.0.0",
                STUDY_BUDDY_WORKFLOW_ROOT: "/workspace/study-buddy",
                STUDY_BUDDY_DESKTOP_UPDATE_REPOSITORY: "HabsaTheDog/StudyBuddy",
                STUDY_BUDDY_DESKTOP_UPDATE_CHANNEL: "latest",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
