// @effect-diagnostics nodeBuiltinImport:off - This module is the injected Node process boundary.
import { spawn } from "node:child_process";
import { spawn as spawnPty } from "node-pty";

import type {
  ProviderSetupChildProcess,
  ProviderSetupProcessSpawner,
  ProviderSetupSpawnInput,
} from "./types.ts";

function writeStdin(stdin: NodeJS.WritableStream, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(input, (error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export const nodeProviderSetupProcessSpawner: ProviderSetupProcessSpawner = {
  spawn: async (input: ProviderSetupSpawnInput): Promise<ProviderSetupChildProcess> => {
    if (input.pty) {
      return spawnProviderSetupPty(input);
    }
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const completion = new Promise<{
      readonly exitCode: number | null;
      readonly signal: string | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      void completion.catch(() => undefined);
      throw error;
    }

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      writeStdin: (value) => writeStdin(child.stdin, value),
      closeStdin: () => child.stdin.end(),
      wait: () => completion,
      kill: (signal) => {
        child.kill(signal);
      },
    };
  },
};

function spawnProviderSetupPty(input: ProviderSetupSpawnInput): ProviderSetupChildProcess {
  const terminal = spawnPty(input.command, [...input.args], {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env ? { ...process.env, ...input.env } : process.env,
    name: "xterm-256color",
    cols: 100,
    rows: 30,
  });
  const output = new AsyncChunkQueue();
  terminal.onData((data) => output.push(data));
  const completion = new Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>((resolve) => {
    terminal.onExit(({ exitCode, signal }) => {
      output.close();
      resolve({ exitCode, signal: signal === undefined ? null : String(signal) });
    });
  });

  return {
    stdout: output,
    stderr: emptyChunks(),
    writeStdin: async (value) => terminal.write(value),
    closeStdin: () => undefined,
    wait: () => completion,
    kill: (signal) => terminal.kill(signal),
  };
}

class AsyncChunkQueue implements AsyncIterable<string> {
  readonly #chunks: string[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  push(value: string): void {
    if (this.#closed) return;
    this.#chunks.push(value);
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (!this.#closed || this.#chunks.length > 0) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }
}

function emptyChunks(): AsyncIterable<string> {
  const queue = new AsyncChunkQueue();
  queue.close();
  return queue;
}
