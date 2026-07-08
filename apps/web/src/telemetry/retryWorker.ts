import { TelemetryOutbox } from "./outbox";

export interface TelemetryUploadResult {
  readonly ok: boolean;
  readonly permanent?: boolean;
  readonly retryAfterMs?: number;
  readonly error?: string;
}

export interface TelemetryUploader {
  readonly upload: (
    items: Awaited<ReturnType<TelemetryOutbox["listDue"]>>,
    options?: { readonly keepalive?: boolean },
  ) => Promise<TelemetryUploadResult>;
}

export class PostHogBatchUploader implements TelemetryUploader {
  constructor(
    private readonly options: {
      readonly host: string;
      readonly projectToken: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  async upload(
    items: Awaited<ReturnType<TelemetryOutbox["listDue"]>>,
    options?: { readonly keepalive?: boolean },
  ): Promise<TelemetryUploadResult> {
    if (items.length === 0) return { ok: true };
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const host = this.options.host.replace(/\/+$/u, "");
    const ordinaryItems = items.filter(
      (item) => item.category !== "conversation" && item.kind !== "replay",
    );
    const conversationItems = items.filter((item) => item.category === "conversation");
    try {
      const requests: Promise<Response>[] = [];
      if (ordinaryItems.length > 0) {
        requests.push(
          fetchImpl(`${host}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: this.options.projectToken,
              batch: ordinaryItems.map((item) => ({
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
        );
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
        requests.push(
          fetchImpl(`${host}/i/v0/ai`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.options.projectToken}` },
            body: form,
            keepalive: options?.keepalive ?? false,
            credentials: "omit",
          }),
        );
      }

      const responses = await Promise.all(requests);
      const failedResponses = responses.filter((candidate) => !candidate.ok);
      const response =
        failedResponses.find(
          (candidate) =>
            candidate.status < 400 || candidate.status >= 500 || candidate.status === 429,
        ) ?? failedResponses[0];
      if (!response) return { ok: true };
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return {
        ok: false,
        permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        error: `PostHog ingestion returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "PostHog ingestion failed.",
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
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    this.#window?.removeEventListener("online", this.#handleOnline);
    this.#window?.removeEventListener("pagehide", this.#handlePageHide);
  }

  flush(options?: { readonly keepalive?: boolean }): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = this.#performFlush(options)
      .catch(() => undefined)
      .finally(() => {
        this.#flushPromise = null;
      });
    return this.#flushPromise;
  }

  async #performFlush(options?: { readonly keepalive?: boolean }): Promise<void> {
    const due = await this.outbox.listDue();
    const eligible = this.#shouldUpload ? due.filter(this.#shouldUpload) : due;
    const keepalive = options?.keepalive === true;
    const items = selectUploadBatch(eligible, keepalive ? 60 * 1024 : 5 * 1024 * 1024, {
      allowOversizedSingle: !keepalive,
    });
    if (items.length === 0) return;
    const result = await this.uploader.upload(items, options);
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
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
