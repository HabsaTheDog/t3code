import { TelemetryOutbox } from "./outbox";

export interface TelemetryUploadResult {
  readonly ok: boolean;
  readonly permanent?: boolean;
  readonly retryAfterMs?: number;
  readonly error?: string;
  readonly outcomes?: ReadonlyArray<{
    readonly ids: ReadonlyArray<string>;
    readonly result: Omit<TelemetryUploadResult, "outcomes">;
  }>;
}

export interface TelemetryUploader {
  readonly upload: (
    items: Awaited<ReturnType<TelemetryOutbox["listDue"]>>,
    options?: { readonly keepalive?: boolean; readonly signal?: AbortSignal },
  ) => Promise<TelemetryUploadResult>;
}

export class PostHogBatchUploader implements TelemetryUploader {
  constructor(
    private readonly options: {
      readonly host: string;
      readonly projectToken: string;
      readonly fetch?: typeof fetch;
      readonly timeoutMs?: number;
    },
  ) {}

  async upload(
    items: Awaited<ReturnType<TelemetryOutbox["listDue"]>>,
    options?: { readonly keepalive?: boolean; readonly signal?: AbortSignal },
  ): Promise<TelemetryUploadResult> {
    if (items.length === 0) return { ok: true };
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const host = this.options.host.replace(/\/+$/u, "");
    const ordinaryItems = items.filter(
      (item) => item.event !== "$ai_generation" && item.kind !== "replay",
    );
    const conversationItems = items.filter((item) => item.event === "$ai_generation");
    try {
      const requests: Array<{ ids: string[]; run: () => Promise<Response> }> = [];
      const request = (url: string, init: RequestInit) =>
        fetchImpl(url, {
          ...init,
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
              ])
            : AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
      if (ordinaryItems.length > 0) {
        requests.push({
          ids: ordinaryItems.map((item) => item.id),
          run: () =>
            request(`${host}/batch/`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                api_key: this.options.projectToken,
                batch: ordinaryItems.map((item) => ({
                  uuid: item.id,
                  event: item.event,
                  properties: {
                    ...item.payload,
                    $process_person_profile: false,
                    $insert_id: item.idempotencyKey,
                  },
                  timestamp: new Date(item.createdAt).toISOString(),
                })),
              }),
              keepalive: options?.keepalive ?? false,
              credentials: "omit",
            }),
        });
      }
      for (const item of conversationItems) {
        const form = new FormData();
        form.append(
          "event",
          new Blob(
            [
              JSON.stringify({
                uuid: item.id,
                event: item.event,
                distinct_id: item.payload.distinct_id,
                timestamp: new Date(item.createdAt).toISOString(),
              }),
            ],
            { type: "application/json" },
          ),
        );
        form.append(
          "event.properties",
          new Blob(
            [
              JSON.stringify({
                ...item.payload,
                $process_person_profile: false,
                $insert_id: item.idempotencyKey,
              }),
            ],
            { type: "application/json" },
          ),
        );
        requests.push({
          ids: [item.id],
          run: () =>
            request(`${host}/i/v0/ai`, {
              method: "POST",
              headers: { Authorization: `Bearer ${this.options.projectToken}` },
              body: form,
              keepalive: options?.keepalive ?? false,
              credentials: "omit",
            }),
        });
      }

      const outcomes: NonNullable<TelemetryUploadResult["outcomes"]>[number][] = [];
      // Bound concurrent AI requests when draining an offline queue.
      for (let offset = 0; offset < requests.length; offset += 4) {
        outcomes.push(
          ...(await Promise.all(
            requests.slice(offset, offset + 4).map(async (entry) => {
              try {
                const response = await entry.run();
                const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
                const result: TelemetryUploadResult = response.ok
                  ? { ok: true }
                  : {
                      ok: false,
                      permanent:
                        response.status >= 400 &&
                        response.status < 500 &&
                        ![408, 429].includes(response.status),
                      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                      error: `PostHog ingestion returned HTTP ${response.status}.`,
                    };
                // Isolate bad/oversized ordinary batches before dropping anything.
                if ([400, 413].includes(response.status) && entry.ids.length > 1) {
                  const subset = items.filter((item) => entry.ids.includes(item.id));
                  const middle = Math.ceil(subset.length / 2);
                  for (const part of [subset.slice(0, middle), subset.slice(middle)]) {
                    const split = await this.upload(part, options);
                    outcomes.push(
                      ...(split.outcomes ?? [{ ids: part.map((item) => item.id), result: split }]),
                    );
                  }
                  return { ids: [], result: { ok: true } };
                }
                return { ids: entry.ids, result };
              } catch {
                return {
                  ids: entry.ids,
                  result: { ok: false, error: "PostHog ingestion failed or timed out." },
                };
              }
            }),
          )),
        );
      }
      const legacy = items.filter((item) => item.kind === "replay").map((item) => item.id);
      if (legacy.length) outcomes.push({ ids: legacy, result: { ok: true } });
      if (outcomes.every((outcome) => outcome.result.ok)) return { ok: true };
      if (outcomes.length === 1) return outcomes[0]!.result;
      return { ok: false, outcomes: outcomes.filter((outcome) => outcome.ids.length > 0) };
    } catch {
      return {
        ok: false,
        error: "PostHog ingestion failed or timed out.",
      };
    }
  }
}

export interface TelemetryRetryWorkerOptions {
  readonly intervalMs?: number;
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly shouldUpload?: (
    item: Awaited<ReturnType<TelemetryOutbox["listDue"]>>[number],
  ) => boolean;
}

export class TelemetryRetryWorker {
  readonly #intervalMs: number;
  readonly #window: Pick<Window, "addEventListener" | "removeEventListener"> | undefined;
  readonly #shouldUpload:
    | ((item: Awaited<ReturnType<TelemetryOutbox["listDue"]>>[number]) => boolean)
    | undefined;
  #interval: ReturnType<typeof setInterval> | null = null;
  #flushPromise: Promise<void> | null = null;
  #flushAgain = false;
  #keepaliveOnNextFlush = false;
  #requestAbort: AbortController | null = null;
  #stopRevision = 0;

  constructor(
    private readonly outbox: TelemetryOutbox,
    private readonly uploader: TelemetryUploader,
    options: TelemetryRetryWorkerOptions = {},
  ) {
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#window = options.window ?? (typeof window === "undefined" ? undefined : window);
    this.#shouldUpload = options.shouldUpload;
  }

  start(): void {
    if (this.#interval !== null) return;
    this.#interval = setInterval(() => void this.flush(), this.#intervalMs);
    this.#window?.addEventListener("online", this.#handleOnline);
    this.#window?.addEventListener("pagehide", this.#handlePageHide);
    void this.flush();
  }

  stop(): void {
    this.#stopRevision += 1;
    this.#requestAbort?.abort();
    this.#flushAgain = false;
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    this.#window?.removeEventListener("online", this.#handleOnline);
    this.#window?.removeEventListener("pagehide", this.#handlePageHide);
  }

  flush(options?: { readonly keepalive?: boolean }): Promise<void> {
    if (this.#flushPromise) {
      this.#flushAgain = true;
      this.#keepaliveOnNextFlush ||= options?.keepalive === true;
      return this.#flushPromise;
    }
    this.#flushPromise = this.#performFlushLoop(options)
      .catch(() => undefined)
      .finally(() => {
        this.#flushPromise = null;
      });
    return this.#flushPromise;
  }

  async #performFlushLoop(options?: { readonly keepalive?: boolean }): Promise<void> {
    let nextOptions = options;
    do {
      this.#flushAgain = false;
      this.#keepaliveOnNextFlush = false;
      await this.#performFlush(nextOptions);
      nextOptions = this.#keepaliveOnNextFlush ? { keepalive: true } : undefined;
    } while (this.#flushAgain);
  }

  async #performFlush(options?: { readonly keepalive?: boolean }): Promise<void> {
    const revision = this.#stopRevision;
    const due = await this.outbox.listDue();
    if (revision !== this.#stopRevision) return;
    const eligible = this.#shouldUpload ? due.filter(this.#shouldUpload) : due;
    const keepalive = options?.keepalive === true;
    const items = selectUploadBatch(eligible, keepalive ? 60 * 1024 : 5 * 1024 * 1024, {
      allowOversizedSingle: !keepalive,
    });
    if (items.length === 0) return;
    const abort = new AbortController();
    this.#requestAbort = abort;
    let result: TelemetryUploadResult;
    try {
      result = await this.uploader.upload(items, { ...options, signal: abort.signal });
    } finally {
      if (this.#requestAbort === abort) this.#requestAbort = null;
    }
    if (abort.signal.aborted) return;
    if (result.outcomes) {
      for (const outcome of result.outcomes) {
        await this.#applyResult(
          items.filter((item) => outcome.ids.includes(item.id)),
          outcome.result,
        );
      }
      return;
    }
    await this.#applyResult(items, result);
  }

  async #applyResult(
    items: Awaited<ReturnType<TelemetryOutbox["listDue"]>>,
    result: TelemetryUploadResult,
  ): Promise<void> {
    if (items.length === 0) return;
    if (result.ok) {
      await this.outbox.markSucceeded(items.map((item) => item.id));
      return;
    }
    if (result.permanent) {
      await this.outbox.markDropped(
        items.map((item) => item.id),
        result.error ?? "PostHog permanently rejected telemetry.",
      );
      return;
    }
    await this.outbox.markFailed(
      items,
      result.error ?? "PostHog ingestion failed.",
      result.retryAfterMs,
    );
  }

  readonly #handleOnline = () => {
    void this.flush();
  };

  readonly #handlePageHide = () => {
    void this.flush({ keepalive: true });
  };
}

export function selectUploadBatch<T extends { readonly sizeBytes: number }>(
  items: ReadonlyArray<T>,
  maxBytes: number,
  options: { readonly allowOversizedSingle?: boolean } = {},
): ReadonlyArray<T> {
  const selected: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (item.sizeBytes > maxBytes) {
      if (selected.length === 0 && options.allowOversizedSingle) return [item];
      continue;
    }
    if (bytes + item.sizeBytes > maxBytes) break;
    selected.push(item);
    bytes += item.sizeBytes;
  }
  return selected;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(6 * 60 * 60 * 1_000, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(6 * 60 * 60 * 1_000, Math.max(0, date - now)) : undefined;
}
