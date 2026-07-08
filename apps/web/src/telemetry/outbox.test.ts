import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import { TelemetryOutbox, calculateRetryDelay } from "./outbox";

function makeOutbox(options?: { maxBytes?: number; now?: number }) {
  let now = options?.now ?? 1_000;
  let id = 0;
  const outbox = new TelemetryOutbox({
    indexedDB: new IDBFactory(),
    databaseName: `telemetry-test-${Math.random()}`,
    ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    clock: { now: () => now },
    random: {
      uuid: () => `id-${++id}`,
      unit: () => 0.5,
    },
  });
  return {
    outbox,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("TelemetryOutbox", () => {
  it("deduplicates idempotency keys and reports durable diagnostics", async () => {
    const { outbox } = makeOutbox();
    const input = {
      category: "analytics" as const,
      kind: "analytics" as const,
      event: "app.started",
      idempotencyKey: "start-1",
      payload: { distinct_id: "install" },
    };
    await expect(outbox.enqueue(input)).resolves.toBe("enqueued");
    await expect(outbox.enqueue(input)).resolves.toBe("duplicate");
    await expect(outbox.status()).resolves.toMatchObject({
      queuedItems: 1,
      droppedCount: 0,
      oldestItemAt: new Date(1_000).toISOString(),
    });
  });

  it("persists queued items across an Electron renderer restart", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = `telemetry-reload-${Math.random()}`;
    const first = new TelemetryOutbox({
      indexedDB,
      databaseName,
      random: { uuid: () => "persisted-item", unit: () => 0.5 },
    });
    await first.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      idempotencyKey: "persisted-turn",
      payload: { distinct_id: "install" },
    });
    first.close();

    const afterRestart = new TelemetryOutbox({ indexedDB, databaseName });
    expect(await afterRestart.status()).toMatchObject({
      queuedItems: 1,
      queuedBytes: expect.any(Number),
    });
    expect((await afterRestart.listDue())[0]?.idempotencyKey).toBe("persisted-turn");
    afterRestart.close();
  });

  it("evicts replay before analytics and preserves conversations", async () => {
    const { outbox, setNow } = makeOutbox({ maxBytes: 1_050 });
    await outbox.enqueue({
      category: "analytics",
      kind: "replay",
      event: "$snapshot",
      idempotencyKey: "replay",
      payload: { chunk: "r".repeat(100) },
    });
    setNow(2_000);
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "feature.used",
      idempotencyKey: "analytics",
      payload: { feature: "settings" },
    });
    setNow(3_000);
    await outbox.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      idempotencyKey: "conversation",
      payload: { output: "answer" },
    });

    const due = await outbox.listDue();
    expect(due.map((item) => item.kind)).not.toContain("replay");
    expect(due.map((item) => item.kind)).toContain("conversation");
    expect((await outbox.status()).droppedCount).toBeGreaterThan(0);
  });

  it("expires items after the configured maximum age", async () => {
    const { outbox, setNow } = makeOutbox({ now: 0 });
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "old",
      payload: {},
    });
    setNow(31 * 24 * 60 * 60 * 1_000);
    expect(await outbox.pruneExpired()).toBe(1);
    expect(await outbox.status()).toMatchObject({ queuedItems: 0, droppedCount: 1 });
  });

  it("clears categories independently", async () => {
    const { outbox } = makeOutbox();
    await outbox.enqueue({
      category: "analytics",
      kind: "analytics",
      event: "app.started",
      idempotencyKey: "analytics",
      payload: {},
    });
    await outbox.enqueue({
      category: "conversation",
      kind: "conversation",
      event: "$ai_generation",
      idempotencyKey: "conversation",
      payload: {},
    });
    await outbox.clearCategory("analytics");
    expect((await outbox.listDue()).map((item) => item.category)).toEqual(["conversation"]);
  });
});

describe("calculateRetryDelay", () => {
  it("uses bounded exponential backoff with jitter", () => {
    expect(calculateRetryDelay(1, 0)).toBe(500);
    expect(calculateRetryDelay(2, 0.5)).toBe(2_000);
    expect(calculateRetryDelay(30, 1)).toBe(9 * 60 * 60 * 1_000);
  });
});
