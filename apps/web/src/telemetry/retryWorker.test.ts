import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vite-plus/test";

import { TelemetryOutbox } from "./outbox";
import type { TelemetryOutboxItem } from "./types";
import {
  PostHogBatchUploader,
  TelemetryRetryWorker,
  parseRetryAfter,
  selectUploadBatch,
} from "./retryWorker";

const CREATED_AT = Date.parse("2026-06-29T08:00:00.000Z");

function outboxItem(overrides: Partial<TelemetryOutboxItem> = {}): TelemetryOutboxItem {
  return {
    id: "outbox-item",
    idempotencyKey: "idempotency-key",
    category: "analytics",
    kind: "analytics",
    event: "app.started",
    payload: { distinct_id: "installation-id", safe: "value" },
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 30 * 24 * 60 * 60 * 1_000,
    attemptCount: 0,
    nextAttemptAt: CREATED_AT,
    sizeBytes: 512,
    ...overrides,
  };
}

async function formJson(form: FormData, name: string): Promise<Record<string, unknown>> {
  const value = form.get(name);
  expect(value).toBeInstanceOf(Blob);
  return JSON.parse(await (value as Blob).text()) as Record<string, unknown>;
}

describe("PostHogBatchUploader", () => {
  it("uploads ordinary analytics and discards legacy queued replay snapshots", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test/",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });

    await expect(
      uploader.upload([
        outboxItem(),
        outboxItem({
          id: "replay-item",
          idempotencyKey: "replay-key",
          category: "analytics",
          kind: "replay",
          event: "$snapshot",
          payload: { distinct_id: "installation-id", snapshot: "data" },
        }),
      ]),
    ).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [batchUrl, batchInit] = fetchSpy.mock.calls[0]!;
    expect(batchUrl).toBe("https://analytics.example.test/batch/");
    expect(new Headers(batchInit?.headers).get("content-type")).toBe("application/json");
    expect(batchInit?.credentials).toBe("omit");
    expect(JSON.parse(String(batchInit?.body))).toEqual({
      api_key: "phc_test",
      batch: [
        {
          event: "app.started",
          properties: {
            distinct_id: "installation-id",
            safe: "value",
            $process_person_profile: false,
            $insert_id: "idempotency-key",
          },
          timestamp: "2026-06-29T08:00:00.000Z",
        },
      ],
    });
  });

  it("uploads each conversation as authenticated multipart AI ingestion", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });
    const conversation = outboxItem({
      id: "stable-outbox-id",
      idempotencyKey: "conversation:thread:turn",
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      payload: {
        distinct_id: "installation-id",
        $ai_session_id: "thread-id",
        $ai_trace_id: "turn-id",
        $ai_input: [{ role: "user", content: "redacted input" }],
      },
    });

    await expect(uploader.upload([conversation])).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://analytics.example.test/i/v0/ai");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer phc_test");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect((form.get("event") as Blob).type).toBe("application/json");
    expect((form.get("event.properties") as Blob).type).toBe("application/json");
    expect(await formJson(form, "event")).toEqual({
      uuid: "stable-outbox-id",
      event: "$ai_generation",
      distinct_id: "installation-id",
      timestamp: "2026-06-29T08:00:00.000Z",
    });
    expect(await formJson(form, "event.properties")).toEqual({
      distinct_id: "installation-id",
      $ai_session_id: "thread-id",
      $ai_trace_id: "turn-id",
      $ai_input: [{ role: "user", content: "redacted input" }],
      $process_person_profile: false,
      $insert_id: "conversation:thread:turn",
    });
  });

  it("splits mixed items between batch and per-conversation AI requests", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });
    const conversationOne = outboxItem({
      id: "conversation-one",
      idempotencyKey: "turn-one",
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
    });
    const conversationTwo = outboxItem({
      id: "conversation-two",
      idempotencyKey: "turn-two",
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
    });

    await uploader.upload([outboxItem({ id: "analytics" }), conversationOne, conversationTwo]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "https://analytics.example.test/batch/",
      "https://analytics.example.test/i/v0/ai",
      "https://analytics.example.test/i/v0/ai",
    ]);
    const firstAiForm = fetchSpy.mock.calls[1]![1]?.body as FormData;
    const secondAiForm = fetchSpy.mock.calls[2]![1]?.body as FormData;
    expect((await formJson(firstAiForm, "event")).uuid).toBe("conversation-one");
    expect((await formJson(secondAiForm, "event")).uuid).toBe("conversation-two");
  });

  it("retries a mixed partial success with stable identifiers", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "4" } }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });
    const items = [
      outboxItem({ id: "analytics" }),
      outboxItem({
        id: "stable-conversation-id",
        idempotencyKey: "stable-conversation-insert-id",
        category: "conversation",
        kind: "conversation",
        event: "$ai_generation",
      }),
    ];

    await expect(uploader.upload(items)).resolves.toEqual({
      ok: false,
      permanent: false,
      retryAfterMs: 4_000,
      error: "PostHog ingestion returned HTTP 429.",
    });
    await expect(uploader.upload(items)).resolves.toEqual({ ok: true });

    const aiForms = [
      fetchSpy.mock.calls[1]![1]?.body,
      fetchSpy.mock.calls[3]![1]?.body,
    ] as FormData[];
    expect(await Promise.all(aiForms.map((form) => formJson(form, "event")))).toEqual([
      expect.objectContaining({ uuid: "stable-conversation-id" }),
      expect.objectContaining({ uuid: "stable-conversation-id" }),
    ]);
    expect(await Promise.all(aiForms.map((form) => formJson(form, "event.properties")))).toEqual([
      expect.objectContaining({ $insert_id: "stable-conversation-insert-id" }),
      expect.objectContaining({ $insert_id: "stable-conversation-insert-id" }),
    ]);
  });

  it.each([
    { status: 429, permanent: false, retryAfterMs: 7_000 },
    { status: 503, permanent: false, retryAfterMs: undefined },
    { status: 400, permanent: true, retryAfterMs: undefined },
  ])("preserves retry semantics for AI HTTP $status", async (expected) => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("", {
        status: expected.status,
        ...(expected.status === 429 ? { headers: { "retry-after": "7" } } : {}),
      }),
    );
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });

    await expect(
      uploader.upload([
        outboxItem({
          category: "conversation",
          kind: "conversation",
          event: "$ai_generation",
        }),
      ]),
    ).resolves.toEqual({
      ok: false,
      permanent: expected.permanent,
      ...(expected.retryAfterMs === undefined ? {} : { retryAfterMs: expected.retryAfterMs }),
      error: `PostHog ingestion returned HTTP ${expected.status}.`,
    });
  });

  it("prefers a retryable response when a mixed request also has a permanent error", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });

    await expect(
      uploader.upload([
        outboxItem(),
        outboxItem({
          category: "conversation",
          kind: "conversation",
          event: "$ai_generation",
        }),
      ]),
    ).resolves.toEqual({
      ok: false,
      permanent: false,
      error: "PostHog ingestion returned HTTP 503.",
    });
  });

  it("returns transport errors for AI ingestion failures", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });

    await expect(
      uploader.upload([
        outboxItem({
          category: "conversation",
          kind: "conversation",
          event: "$ai_generation",
        }),
      ]),
    ).resolves.toEqual({
      ok: false,
      error: "network unavailable",
    });
  });

  it("reuses stable AI event and insertion identifiers across retries", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    const uploader = new PostHogBatchUploader({
      host: "https://analytics.example.test",
      projectToken: "phc_test",
      fetch: fetchSpy,
    });
    const item = outboxItem({
      id: "stable-event-id",
      idempotencyKey: "stable-insert-id",
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
    });

    await uploader.upload([item]);
    await uploader.upload([item]);

    const forms = fetchSpy.mock.calls.map(([, init]) => init?.body as FormData);
    expect(await Promise.all(forms.map((form) => formJson(form, "event")))).toEqual([
      expect.objectContaining({ uuid: "stable-event-id" }),
      expect.objectContaining({ uuid: "stable-event-id" }),
    ]);
    expect(await Promise.all(forms.map((form) => formJson(form, "event.properties")))).toEqual([
      expect.objectContaining({ $insert_id: "stable-insert-id" }),
      expect.objectContaining({ $insert_id: "stable-insert-id" }),
    ]);
  });
});

describe("TelemetryRetryWorker", () => {
  it("retains and schedules items after 429 responses", async () => {
    let now = 1_000;
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `retry-test-${Math.random()}`,
      clock: { now: () => now },
      random: { uuid: () => "item", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "start",
      payload: { distinct_id: "install" },
    });
    const fetchSpy = vi.fn(
      async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "5" },
        }),
    );
    const worker = new TelemetryRetryWorker(
      outbox,
      new PostHogBatchUploader({
        host: "https://analytics.example.test",
        projectToken: "phc_test",
        fetch: fetchSpy,
      }),
    );
    await worker.flush();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(await outbox.listDue()).toHaveLength(0);
    now += 5_000;
    expect(await outbox.listDue()).toHaveLength(1);
    expect((await outbox.listDue())[0]?.attemptCount).toBe(1);
  });

  it("removes items after a successful recovery", async () => {
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `recovery-test-${Math.random()}`,
      random: { uuid: () => "item", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "start",
      payload: {},
    });
    const worker = new TelemetryRetryWorker(outbox, {
      upload: vi.fn(async () => ({ ok: true })),
    });
    await worker.flush();
    expect(await outbox.status()).toMatchObject({
      queuedItems: 0,
      lastError: null,
    });
  });

  it("flushes an event queued while an earlier flush is still reading the outbox", async () => {
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `coalesced-flush-${Math.random()}`,
      random: { uuid: () => "late-item", unit: () => 0.5 },
    });
    const originalListDue = outbox.listDue.bind(outbox);
    let releaseFirstRead: (() => void) | undefined;
    vi.spyOn(outbox, "listDue").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstRead = () => resolve([]);
        }),
    );
    const upload = vi.fn(async () => ({ ok: true }));
    const worker = new TelemetryRetryWorker(outbox, { upload });

    const firstFlush = worker.flush();
    await vi.waitFor(() => expect(releaseFirstRead).toEqual(expect.any(Function)));
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "queued-during-flush",
      payload: {},
    });
    const coalescedFlush = worker.flush();
    releaseFirstRead?.();
    await Promise.all([firstFlush, coalescedFlush]);

    expect(outbox.listDue).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledOnce();
    expect(await originalListDue()).toHaveLength(0);
  });

  it("retains items after a 5xx response and retries later", async () => {
    let now = 1_000;
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `retry-5xx-${Math.random()}`,
      clock: { now: () => now },
      random: { uuid: () => "item-5xx", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      idempotencyKey: "turn-5xx",
      payload: {},
    });
    const fetchSpy = vi.fn(async () => new Response("", { status: 503 }));
    const worker = new TelemetryRetryWorker(
      outbox,
      new PostHogBatchUploader({
        host: "https://analytics.example.test",
        projectToken: "phc_test",
        fetch: fetchSpy,
      }),
    );
    await worker.flush();
    expect(await outbox.listDue()).toHaveLength(0);
    now += 1_000;
    expect(await outbox.listDue()).toHaveLength(1);
  });

  it("synchronizes exactly once after an ingestion outage recovers", async () => {
    let now = 1_000;
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `outage-recovery-${Math.random()}`,
      clock: { now: () => now },
      random: { uuid: () => "item-recovery", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "recovery-event",
      payload: { distinct_id: "installation" },
    });
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const worker = new TelemetryRetryWorker(
      outbox,
      new PostHogBatchUploader({
        host: "https://analytics.example.test",
        projectToken: "phc_test",
        fetch: fetchSpy,
      }),
    );

    await worker.flush();
    now += 1_000;
    await worker.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await outbox.status()).toMatchObject({
      queuedItems: 0,
      lastError: null,
    });
  });

  it("never uploads an item rejected by the current consent predicate", async () => {
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `consent-filter-test-${Math.random()}`,
      random: { uuid: () => "item", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "start",
      payload: {},
    });
    const upload = vi.fn(async () => ({ ok: true }));
    const worker = new TelemetryRetryWorker(
      outbox,
      { upload },
      {
        shouldUpload: (item) => item.category === "conversation",
      },
    );
    await worker.flush();
    expect(upload).not.toHaveBeenCalled();
    expect(await outbox.status()).toMatchObject({ queuedItems: 1 });
  });

  it("drops and diagnoses batches permanently rejected by ingestion", async () => {
    const outbox = new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `permanent-rejection-${Math.random()}`,
      random: { uuid: () => "rejected-item", unit: () => 0.5 },
    });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "rejected",
      payload: {},
    });
    const worker = new TelemetryRetryWorker(
      outbox,
      new PostHogBatchUploader({
        host: "https://analytics.example.test",
        projectToken: "phc_test",
        fetch: vi.fn(async () => new Response("", { status: 413 })),
      }),
    );

    await worker.flush();

    expect(await outbox.status()).toMatchObject({
      queuedItems: 0,
      droppedCount: 1,
      lastError: "PostHog ingestion returned HTTP 413.",
    });
  });
});

describe("parseRetryAfter", () => {
  it("supports delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("3", 0)).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });
});

describe("selectUploadBatch", () => {
  it("keeps shutdown delivery within the browser keepalive budget", () => {
    const items = [{ sizeBytes: 30_000 }, { sizeBytes: 25_000 }, { sizeBytes: 10_000 }];
    expect(selectUploadBatch(items, 60_000)).toEqual(items.slice(0, 2));
    expect(selectUploadBatch([{ sizeBytes: 70_000 }, { sizeBytes: 10_000 }], 60_000)).toEqual([
      { sizeBytes: 10_000 },
    ]);
    expect(
      selectUploadBatch([{ sizeBytes: 70_000 }, { sizeBytes: 10_000 }], 60_000, {
        allowOversizedSingle: true,
      }),
    ).toEqual([{ sizeBytes: 70_000 }]);
  });
});
