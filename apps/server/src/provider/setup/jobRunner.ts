// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { randomUUID } from "node:crypto";

import {
  detectProviderSetupPlatform,
  resolveProviderSetupAction,
  type ResolvedProviderSetupAction,
} from "./capabilities.ts";
import { makeProviderSetupProgressSanitizer, sanitizeProviderSetupOutput } from "./sanitize.ts";
import type {
  ProviderSetupChildProcess,
  ProviderSetupJobEvent,
  ProviderSetupJobHandle,
  ProviderSetupJobRequest,
  ProviderSetupPlatform,
  ProviderSetupProcessSpawner,
  ProviderSetupProvider,
  ProviderSetupTerminalEvent,
} from "./types.ts";

export class ProviderSetupRequestError extends Error {
  readonly code:
    | "unknown_action"
    | "unsupported_action"
    | "confirmation_required"
    | "secret_required"
    | "unexpected_secret";

  constructor(code: ProviderSetupRequestError["code"], message: string) {
    super(message);
    this.name = "ProviderSetupRequestError";
    this.code = code;
  }
}

class ReplayEventStream<T> implements AsyncIterable<T> {
  readonly #events: T[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  push(event: T): void {
    if (this.#closed) return;
    this.#events.push(event);
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.#events.length) {
        yield this.#events[cursor++]!;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }
}

interface ActiveJob {
  readonly action: ResolvedProviderSetupAction;
  readonly stream: ReplayEventStream<ProviderSetupJobEvent>;
  readonly sensitiveValues: string[];
  child: ProviderSetupChildProcess | null;
  cancelled: boolean;
  terminal: boolean;
}

export interface ProviderSetupJobRunnerOptions {
  readonly spawner: ProviderSetupProcessSpawner;
  readonly refreshProviderStatus: (provider: ProviderSetupProvider) => Promise<void>;
  readonly platform?: ProviderSetupPlatform | undefined;
  readonly now?: (() => string) | undefined;
  readonly createJobId?: (() => string) | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export class ProviderSetupJobRunner {
  readonly #spawner: ProviderSetupProcessSpawner;
  readonly #refreshProviderStatus: (provider: ProviderSetupProvider) => Promise<void>;
  readonly #platform: ProviderSetupPlatform;
  readonly #now: () => string;
  readonly #createJobId: () => string;
  readonly #cwd: string | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #jobs = new Map<string, ActiveJob>();

  constructor(options: ProviderSetupJobRunnerOptions) {
    this.#spawner = options.spawner;
    this.#refreshProviderStatus = options.refreshProviderStatus;
    this.#platform = options.platform ?? detectProviderSetupPlatform();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createJobId = options.createJobId ?? randomUUID;
    this.#cwd = options.cwd;
    this.#env = options.env;
  }

  start(request: ProviderSetupJobRequest): ProviderSetupJobHandle {
    const action = this.#validateRequest(request);
    const jobId = this.#createJobId();
    const stream = new ReplayEventStream<ProviderSetupJobEvent>();
    const sensitiveValues = request.secretValue ? [request.secretValue] : [];
    const job: ActiveJob = {
      action,
      stream,
      sensitiveValues,
      child: null,
      cancelled: false,
      terminal: false,
    };
    this.#jobs.set(jobId, job);

    const completion = Promise.resolve()
      .then(() => this.#execute(jobId, job, request.secretValue))
      .finally(() => {
        job.terminal = true;
        job.child = null;
        stream.close();
        const cleanupTimer = setTimeout(() => {
          if (this.#jobs.get(jobId) === job) {
            this.#jobs.delete(jobId);
          }
        }, 5 * 60_000);
        cleanupTimer.unref();
      });

    return {
      jobId,
      events: stream,
      completion,
      writeInput: (value) => this.writeInput(jobId, value),
      cancel: () => this.cancel(jobId),
    };
  }

  cancel(jobId: string): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.cancelled || job.terminal) return false;
    job.cancelled = true;
    const child = job.child;
    child?.kill("SIGTERM");
    if (child) {
      const forceKillTimer = setTimeout(() => {
        if (this.#jobs.get(jobId)?.child === child) {
          child.kill("SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref();
    }
    return true;
  }

  events(jobId: string): AsyncIterable<ProviderSetupJobEvent> | null {
    return this.#jobs.get(jobId)?.stream ?? null;
  }

  async writeInput(jobId: string, input: string): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (
      !job ||
      job.cancelled ||
      !job.child ||
      job.action.interaction !== "sanitized-terminal" ||
      Buffer.byteLength(input, "utf8") > 16_384
    ) {
      return false;
    }
    const sensitiveInput = input.trim();
    if (sensitiveInput.length > 0) {
      job.sensitiveValues.push(sensitiveInput);
    }
    await job.child.writeStdin(input);
    return true;
  }

  #validateRequest(request: ProviderSetupJobRequest): ResolvedProviderSetupAction {
    const action = resolveProviderSetupAction(request.actionId, this.#platform);
    if (!action) {
      throw new ProviderSetupRequestError(
        "unknown_action",
        "The requested provider setup action is not allowlisted.",
      );
    }
    if (action.unsupportedReason) {
      throw new ProviderSetupRequestError("unsupported_action", action.unsupportedReason);
    }
    if (action.requiresConfirmation && request.confirmed !== true) {
      throw new ProviderSetupRequestError(
        "confirmation_required",
        "Provider installation requires explicit confirmation.",
      );
    }
    if (action.secretInput && !request.secretValue?.trim()) {
      throw new ProviderSetupRequestError(
        "secret_required",
        "This provider setup action requires a write-only secret.",
      );
    }
    if (!action.secretInput && request.secretValue !== undefined) {
      throw new ProviderSetupRequestError(
        "unexpected_secret",
        "This provider setup action does not accept a secret.",
      );
    }
    return action;
  }

  async #execute(
    jobId: string,
    job: ActiveJob,
    secretValue: string | undefined,
  ): Promise<ProviderSetupTerminalEvent> {
    if (job.cancelled) {
      return this.#terminalEvent(jobId, job, { type: "cancelled" });
    }

    this.#event(jobId, job, { type: "started" });

    try {
      const child = await this.#spawner.spawn({
        command: job.action.executable,
        args: [...job.action.args],
        cwd: this.#cwd,
        env: this.#env,
        pty: job.action.interaction === "sanitized-terminal",
      });
      job.child = child;

      if (job.cancelled) {
        child.kill("SIGTERM");
      }

      const stdout = this.#consumeProgress(jobId, job, "stdout", child.stdout);
      const stderr = this.#consumeProgress(jobId, job, "stderr", child.stderr);

      if (secretValue !== undefined) {
        await child.writeStdin(`${secretValue}\n`);
        child.closeStdin();
      }

      const [result] = await Promise.all([child.wait(), stdout, stderr]);
      job.child = null;

      if (job.cancelled) {
        return this.#terminalEvent(jobId, job, { type: "cancelled" });
      }
      if (result.exitCode !== 0) {
        return this.#terminalEvent(jobId, job, {
          type: "failed",
          message:
            result.exitCode === null
              ? "Provider setup process ended without an exit code."
              : `Provider setup process exited with code ${result.exitCode}.`,
          exitCode: result.exitCode,
        });
      }

      await this.#refreshProviderStatus(job.action.provider);
      if (job.cancelled) {
        return this.#terminalEvent(jobId, job, { type: "cancelled" });
      }
      return this.#terminalEvent(jobId, job, { type: "completed", exitCode: 0 });
    } catch (error) {
      job.child = null;
      if (job.cancelled) {
        return this.#terminalEvent(jobId, job, { type: "cancelled" });
      }
      const rawMessage = error instanceof Error ? error.message : "Provider setup failed.";
      const message = sanitizeProviderSetupOutput(rawMessage, job.sensitiveValues);
      return this.#terminalEvent(jobId, job, {
        type: "failed",
        message: message || "Provider setup failed.",
        exitCode: null,
      });
    }
  }

  async #consumeProgress(
    jobId: string,
    job: ActiveJob,
    stream: "stdout" | "stderr",
    chunks: AsyncIterable<Uint8Array | string>,
  ): Promise<void> {
    const sanitizer = makeProviderSetupProgressSanitizer({
      sensitiveValues: job.sensitiveValues,
      emit: (text) => this.#event(jobId, job, { type: "progress", stream, text }),
    });
    for await (const chunk of chunks) {
      sanitizer.write(chunk);
    }
    sanitizer.end();
  }

  #event(
    jobId: string,
    job: ActiveJob,
    event:
      | { readonly type: "started" }
      | {
          readonly type: "progress";
          readonly stream: "stdout" | "stderr" | "system";
          readonly text: string;
        },
  ): void {
    job.stream.push({
      ...event,
      jobId,
      actionId: job.action.id,
      provider: job.action.provider,
      timestamp: this.#now(),
    });
  }

  #terminalEvent(
    jobId: string,
    job: ActiveJob,
    event:
      | { readonly type: "completed"; readonly exitCode: 0 }
      | { readonly type: "failed"; readonly message: string; readonly exitCode: number | null }
      | { readonly type: "cancelled" },
  ): ProviderSetupTerminalEvent {
    const terminalEvent = {
      ...event,
      jobId,
      actionId: job.action.id,
      provider: job.action.provider,
      timestamp: this.#now(),
    } satisfies ProviderSetupTerminalEvent;
    job.stream.push(terminalEvent);
    return terminalEvent;
  }
}
