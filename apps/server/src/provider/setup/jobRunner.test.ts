// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderSetupJobRunner,
  ProviderSetupRequestError,
  type ProviderSetupExecution,
} from "./jobRunner.ts";
import { getProviderSetupCapabilities, resolveProviderSetupAction } from "./capabilities.ts";
import { resolveProviderSetupExecution } from "./execution.ts";
import type {
  ProviderSetupChildProcess,
  ProviderSetupJobEvent,
  ProviderSetupProcessResult,
  ProviderSetupSpawnInput,
} from "./types.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

async function* chunks(values: ReadonlyArray<string>): AsyncIterable<string> {
  for (const value of values) yield value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeChild(input?: {
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
  readonly result?: Promise<ProviderSetupProcessResult>;
  readonly onKill?: ((signal: "SIGTERM" | "SIGKILL") => void) | undefined;
}) {
  const writes: string[] = [];
  let stdinClosed = false;
  const child: ProviderSetupChildProcess = {
    stdout: chunks(input?.stdout ?? []),
    stderr: chunks(input?.stderr ?? []),
    writeStdin: async (value) => {
      writes.push(value);
    },
    closeStdin: () => {
      stdinClosed = true;
    },
    wait: () => input?.result ?? Promise.resolve({ exitCode: 0, signal: null }),
    kill: (signal) => input?.onKill?.(signal),
  };
  return {
    child,
    writes,
    get stdinClosed() {
      return stdinClosed;
    },
  };
}

async function collectEvents(
  events: AsyncIterable<ProviderSetupJobEvent>,
): Promise<ProviderSetupJobEvent[]> {
  const collected: ProviderSetupJobEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached.");
}

describe("ProviderSetupJobRunner", () => {
  it("uses current Codex instance configuration while retaining the application security home", async () => {
    const settings = decodeSettings({
      providers: { codex: { binaryPath: "stale-codex" } },
      providerInstances: {
        codex: {
          driver: "codex",
          config: { binaryPath: "custom-codex", homePath: "/external/home" },
          environment: [
            { name: "PATH", value: "/custom/bin", sensitive: false },
            { name: "CODEX_HOME", value: "/external/override", sensitive: false },
            { name: "MOODLE_PASSWORD", value: "private-secret", sensitive: true },
          ],
        },
      },
    });
    const execution = await Effect.runPromise(
      resolveProviderSetupExecution({
        action: resolveProviderSetupAction("codex.auth.browser", {
          platform: "linux",
          isWsl: false,
        })!,
        settings,
        codexPaths: {
          codexHome: "/study-buddy/codex-home",
          configPath: "",
          configRoot: "/study-buddy",
          deniedPaths: [],
        },
        environment: { PATH: "/stale/path" },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(execution.command).toBe("custom-codex");
    expect(execution.env).toMatchObject({
      CODEX_HOME: "/study-buddy/codex-home",
      STUDY_BUDDY_CODEX_PERMISSION_PROFILE: "study_buddy",
    });
    expect(execution.env?.PATH).toContain("/custom/bin");
    expect(execution.env?.MOODLE_PASSWORD).toBeUndefined();
  });

  it("authenticates the discovered default instance using current config and environment per job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sb-setup-execution-"));
    try {
      const configFor = (
        binaryPath: string,
        homePath: string,
        enabled: boolean,
        pathValue = directory,
      ) =>
        decodeSettings({
          providers: { claudeAgent: { binaryPath: "stale-legacy-claude" } },
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              enabled,
              config: { binaryPath, homePath },
              environment: [{ name: "PATH", value: pathValue, sensitive: false }],
            },
          },
        });
      writeFileSync(join(directory, "custom-claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let settings = configFor("custom-claude", join(directory, "first-home"), false);
      const requests: ProviderSetupSpawnInput[] = [];
      const resolveExecution = vi.fn((action) =>
        Effect.runPromise(
          resolveProviderSetupExecution({
            action,
            settings,
            codexPaths: {
              codexHome: join(directory, "codex-home"),
              configPath: "",
              configRoot: directory,
              deniedPaths: [],
            },
            environment: { PATH: "/stale-startup-path" },
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      );
      const runner = new ProviderSetupJobRunner({
        spawner: {
          spawn: async (request) => {
            requests.push(request);
            return makeChild().child;
          },
        },
        refreshProviderStatus: async () => {},
        platform: { platform: "linux", isWsl: false },
        resolveExecution,
      });
      expect(
        getProviderSetupCapabilities({ platform: "linux", isWsl: false }, { settings }).find(
          (provider) => provider.provider === "claude",
        )?.installed,
      ).toBe(true);

      // Enabling the discovered provider updates settings while this runner
      // remains alive; a later settings edit must also affect the next login.
      settings = configFor("custom-claude", join(directory, "first-home"), true);
      expect((await runner.start({ actionId: "claude.auth.login" }).completion).type).toBe(
        "completed",
      );
      settings = configFor(
        "updated-claude",
        join(directory, "second-home"),
        true,
        join(directory, "updated-bin"),
      );
      expect((await runner.start({ actionId: "claude.auth.login" }).completion).type).toBe(
        "completed",
      );

      expect(requests.map((request) => request.command)).toEqual([
        "custom-claude",
        "updated-claude",
      ]);
      expect(requests.map((request) => request.env?.HOME)).toEqual([
        resolve(directory, "first-home"),
        resolve(directory, "second-home"),
      ]);
      expect(requests[0]?.env?.PATH?.split(delimiter)).toContain(directory);
      expect(requests[1]?.env?.PATH?.split(delimiter)).toContain(join(directory, "updated-bin"));
      expect(resolveExecution).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not spawn a job cancelled while current execution settings are resolving", async () => {
    const execution = deferred<ProviderSetupExecution>();
    const resolveExecution = vi.fn(() => execution.promise);
    const spawn = vi.fn(async () => makeChild().child);
    const runner = new ProviderSetupJobRunner({
      spawner: { spawn },
      refreshProviderStatus: async () => {},
      platform: { platform: "linux", isWsl: false },
      resolveExecution,
    });
    const handle = runner.start({ actionId: "codex.auth.browser" });
    await waitUntil(() => resolveExecution.mock.calls.length === 1);
    expect(handle.cancel()).toBe(true);
    execution.resolve({ command: "codex", env: {} });
    expect((await handle.completion).type).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("isolates native login environments by provider", async () => {
    const requests: ProviderSetupSpawnInput[] = [];
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async (request) => {
          requests.push(request);
          return makeChild().child;
        },
      },
      refreshProviderStatus: async () => {},
      platform: { platform: "linux", isWsl: false },
      resolveEnvironment: (action) =>
        action.provider === "claude"
          ? { HOME: "/test/claude-account" }
          : { CODEX_HOME: "/test/codex-account" },
    });
    await runner.start({ actionId: "claude.auth.login" }).completion;
    await runner.start({ actionId: "codex.auth.browser" }).completion;
    expect(requests.map((request) => request.env)).toEqual([
      { HOME: "/test/claude-account" },
      { CODEX_HOME: "/test/codex-account" },
    ]);
  });

  it("runs an allowlisted command, streams sanitized progress, and refreshes status", async () => {
    const spawned: ProviderSetupSpawnInput[] = [];
    const refresh = vi.fn(async () => undefined);
    const fake = makeChild({
      stdout: ["Installing...\n", "\u001b[31mDone\u001b[0m\n"],
    });
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async (input) => {
          spawned.push(input);
          return fake.child;
        },
      },
      refreshProviderStatus: refresh,
      platform: { platform: "linux", isWsl: false },
      now: () => "2026-06-27T00:00:00.000Z",
      createJobId: () => "job-1",
    });

    const handle = runner.start({ actionId: "codex.install", confirmed: true });
    const eventsPromise = collectEvents(handle.events);
    const terminal = await handle.completion;
    const events = await eventsPromise;

    expect(spawned).toEqual([
      {
        command: "sh",
        args: ["-lc", expect.stringContaining("https://chatgpt.com/codex/install.sh")],
        cwd: undefined,
        env: undefined,
        pty: false,
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "progress",
      "progress",
      "completed",
    ]);
    expect(events.filter((event) => event.type === "progress").map((event) => event.text)).toEqual([
      "Installing...",
      "Done",
    ]);
    expect(terminal.type).toBe("completed");
    expect(refresh).toHaveBeenCalledWith("codex");
  });

  it("pipes API keys through stdin without putting them in args, errors, or events", async () => {
    const apiKey = "sk-live-supersecret123456";
    const spawned: ProviderSetupSpawnInput[] = [];
    const fake = makeChild({
      stdout: [`API key=${apiKey.slice(0, 8)}`, `${apiKey.slice(8)}\n`],
      stderr: [`Bearer ${apiKey}\n`],
    });
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async (input) => {
          spawned.push(input);
          return fake.child;
        },
      },
      refreshProviderStatus: async () => undefined,
      resolveCommand: (action) =>
        action.provider === "codex" ? "/opt/study-buddy/bin/codex" : action.executable,
      platform: { platform: "linux", isWsl: false },
      createJobId: () => "job-secret",
    });

    const handle = runner.start({
      actionId: "codex.auth.api-key",
      secretValue: apiKey,
    });
    const eventsPromise = collectEvents(handle.events);
    await handle.completion;
    const events = await eventsPromise;

    expect(spawned[0]).toMatchObject({
      command: "/opt/study-buddy/bin/codex",
      args: ["login", "--with-api-key"],
    });
    expect(JSON.stringify(spawned)).not.toContain(apiKey);
    expect(fake.writes).toEqual([`${apiKey}\n`]);
    expect(fake.stdinClosed).toBe(true);
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(events)).toContain("[REDACTED]");
  });

  it("requires explicit confirmation before any install action can spawn", () => {
    const spawn = vi.fn();
    const runner = new ProviderSetupJobRunner({
      spawner: { spawn },
      refreshProviderStatus: async () => undefined,
      platform: { platform: "linux", isWsl: false },
    });

    expect(() => runner.start({ actionId: "codex.install" })).toThrowError(
      expect.objectContaining<Partial<ProviderSetupRequestError>>({
        code: "confirmation_required",
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects non-Codex and injected action ids without spawning", () => {
    const spawn = vi.fn();
    const runner = new ProviderSetupJobRunner({
      spawner: { spawn },
      refreshProviderStatus: async () => undefined,
      platform: { platform: "win32", isWsl: false },
    });

    expect(() => runner.start({ actionId: "cursor.install", confirmed: true })).toThrowError(
      expect.objectContaining<Partial<ProviderSetupRequestError>>({
        code: "unknown_action",
      }),
    );
    expect(() =>
      runner.start({ actionId: "cursor.install && whoami", confirmed: true }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderSetupRequestError>>({
        code: "unknown_action",
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancels an active process and does not refresh provider status", async () => {
    const result = deferred<ProviderSetupProcessResult>();
    const refresh = vi.fn(async () => undefined);
    const killed: string[] = [];
    let spawned = false;
    const fake = makeChild({
      result: result.promise,
      onKill: (signal) => {
        killed.push(signal);
        result.resolve({ exitCode: null, signal });
      },
    });
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async () => {
          spawned = true;
          return fake.child;
        },
      },
      refreshProviderStatus: refresh,
      platform: { platform: "linux", isWsl: false },
      createJobId: () => "job-cancel",
    });

    const handle = runner.start({ actionId: "codex.auth.browser" });
    const eventsPromise = collectEvents(handle.events);
    await waitUntil(() => spawned);
    expect(handle.cancel()).toBe(true);
    const terminal = await handle.completion;
    const events = await eventsPromise;

    expect(killed).toEqual(["SIGTERM"]);
    expect(terminal.type).toBe("cancelled");
    expect(events.at(-1)?.type).toBe("cancelled");
    expect(refresh).not.toHaveBeenCalled();
    expect(handle.cancel()).toBe(false);
  });

  it("accepts write-only input only for a running sanitized terminal job", async () => {
    const result = deferred<ProviderSetupProcessResult>();
    const fake = makeChild({ result: result.promise });
    let spawned = false;
    let spawnInput: ProviderSetupSpawnInput | null = null;
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async (input) => {
          spawned = true;
          spawnInput = input;
          return fake.child;
        },
      },
      refreshProviderStatus: async () => undefined,
      platform: { platform: "linux", isWsl: false },
      createJobId: () => "job-input",
    });
    const handle = runner.start({ actionId: "codex.auth.browser" });
    await waitUntil(() => spawned);

    expect(spawnInput).toMatchObject({ pty: true });
    expect(await handle.writeInput("terminal-response\n")).toBe(true);
    result.resolve({ exitCode: 0, signal: null });
    await handle.completion;

    expect(fake.writes).toEqual(["terminal-response\n"]);
    expect(await handle.writeInput("too-late")).toBe(false);
  });

  it("returns sanitized failures without refreshing status", async () => {
    const secret = "sk-secret-in-error123";
    const refresh = vi.fn(async () => undefined);
    const runner = new ProviderSetupJobRunner({
      spawner: {
        spawn: async () => {
          throw new Error(`Failed with token=${secret}`);
        },
      },
      refreshProviderStatus: refresh,
      platform: { platform: "linux", isWsl: false },
      createJobId: () => "job-failure",
    });

    const terminal = await runner.start({
      actionId: "codex.auth.api-key",
      secretValue: secret,
    }).completion;

    expect(terminal).toMatchObject({
      type: "failed",
      message: "Failed with token=[REDACTED]",
      exitCode: null,
    });
    expect(JSON.stringify(terminal)).not.toContain(secret);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("includes the sanitized installer diagnostic when a setup process exits nonzero", async () => {
    const secret = "sk-secret-installer123";
    const fake = makeChild({
      stdout: ["Downloading Codex CLI\n"],
      stderr: [`Access denied for token=${secret}\n`, "PowerShell stack detail\n"],
      result: Promise.resolve({ exitCode: 1, signal: null }),
    });
    const runner = new ProviderSetupJobRunner({
      spawner: { spawn: async () => fake.child },
      refreshProviderStatus: async () => undefined,
      platform: { platform: "win32", isWsl: false },
      createJobId: () => "job-installer-failure",
    });

    const terminal = await runner.start({ actionId: "codex.install", confirmed: true }).completion;

    expect(terminal).toMatchObject({
      type: "failed",
      message: "Provider setup process exited with code 1. Access denied for token=[REDACTED]",
      exitCode: 1,
    });
    expect(JSON.stringify(terminal)).not.toContain(secret);
  });

  it("replays a completed job to a subscription opened after completion", async () => {
    const fake = makeChild({ stdout: ["complete\n"] });
    const runner = new ProviderSetupJobRunner({
      spawner: { spawn: async () => fake.child },
      refreshProviderStatus: async () => undefined,
      platform: { platform: "linux", isWsl: false },
      createJobId: () => "job-replay",
    });

    const handle = runner.start({ actionId: "codex.install", confirmed: true });
    await handle.completion;
    const events = runner.events(handle.jobId);

    expect(events).not.toBeNull();
    expect(await collectEvents(events!)).toMatchObject([
      { type: "started", jobId: "job-replay" },
      { type: "progress", text: "complete", jobId: "job-replay" },
      { type: "completed", jobId: "job-replay" },
    ]);
  });
});
