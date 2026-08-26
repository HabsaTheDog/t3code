import { describe, expect, it, vi } from "vitest";

import { ProviderSetupJobRunner, ProviderSetupRequestError } from "./jobRunner.ts";
import type {
  ProviderSetupChildProcess,
  ProviderSetupJobEvent,
  ProviderSetupProcessResult,
  ProviderSetupSpawnInput,
} from "./types.ts";

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
