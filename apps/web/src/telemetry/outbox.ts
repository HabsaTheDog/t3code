import {
  systemTelemetryClock,
  systemTelemetryRandom,
  type TelemetryCategory,
  type TelemetryClock,
  type TelemetryOutboxItem,
  type TelemetryOutboxKind,
  type TelemetryOutboxStatus,
  type TelemetryRandom,
} from "./types";

const DATABASE_NAME = "study-buddy-telemetry-v1";
const DATABASE_VERSION = 1;
const ITEMS_STORE = "items";
const META_STORE = "meta";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1_000;

interface MetaRow {
  readonly key: string;
  readonly value: unknown;
}

export interface EnqueueTelemetryInput {
  readonly idempotencyKey: string;
  readonly category: TelemetryCategory;
  readonly kind: TelemetryOutboxKind;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt?: number;
}

export interface TelemetryOutboxOptions {
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly clock?: TelemetryClock;
  readonly random?: TelemetryRandom;
}

export class TelemetryOutbox {
  readonly #indexedDB: IDBFactory;
  readonly #databaseName: string;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #clock: TelemetryClock;
  readonly #random: TelemetryRandom;
  #databasePromise: Promise<IDBDatabase> | null = null;
  #databaseHandle: IDBDatabase | null = null;

  constructor(options: TelemetryOutboxOptions = {}) {
    const indexedDBFactory = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDBFactory) {
      throw new Error("IndexedDB is unavailable.");
    }
    this.#indexedDB = indexedDBFactory;
    this.#databaseName = options.databaseName ?? DATABASE_NAME;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
    this.#clock = options.clock ?? systemTelemetryClock;
    this.#random = options.random ?? systemTelemetryRandom;
  }

  async enqueue(input: EnqueueTelemetryInput): Promise<"enqueued" | "duplicate" | "dropped"> {
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readwrite");
    const items = transaction.objectStore(ITEMS_STORE);
    const duplicate = await request(items.index("idempotencyKey").getKey(input.idempotencyKey));
    if (duplicate !== undefined) {
      await transactionDone(transaction);
      return "duplicate";
    }

    const createdAt = input.createdAt ?? this.#clock.now();
    const item: TelemetryOutboxItem = {
      id: this.#random.uuid(),
      idempotencyKey: input.idempotencyKey,
      category: input.category,
      kind: input.kind,
      event: input.event,
      payload: input.payload,
      createdAt,
      expiresAt: createdAt + this.#maxAgeMs,
      attemptCount: 0,
      nextAttemptAt: createdAt,
      sizeBytes: estimateBytes(input),
    };
    await request(items.add(item));

    const allItems = (await request(items.getAll())) as TelemetryOutboxItem[];
    const evictedIds = selectCapacityEvictions(allItems, this.#maxBytes, item);
    for (const id of evictedIds) {
      await request(items.delete(id));
    }
    if (evictedIds.length > 0) {
      await incrementMeta(transaction.objectStore(META_STORE), "droppedCount", evictedIds.length);
    }
    await transactionDone(transaction);
    return evictedIds.includes(item.id) ? "dropped" : "enqueued";
  }

  async clearCategory(category: TelemetryCategory): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(ITEMS_STORE, "readwrite");
    const store = transaction.objectStore(ITEMS_STORE);
    const keys = await request(store.index("category").getAllKeys(category));
    for (const key of keys) {
      await request(store.delete(key));
    }
    await transactionDone(transaction);
  }

  async deleteAll(): Promise<void> {
    if (!this.#databaseHandle && this.#databasePromise) {
      await this.#databasePromise.catch(() => null);
    }
    this.close();
    await new Promise<void>((resolve, reject) => {
      const deletion = this.#indexedDB.deleteDatabase(this.#databaseName);
      deletion.addEventListener("success", () => resolve(), { once: true });
      deletion.addEventListener(
        "error",
        () => reject(deletion.error ?? new Error("Failed to delete telemetry outbox.")),
        { once: true },
      );
      deletion.addEventListener(
        "blocked",
        () => reject(new Error("Telemetry outbox deletion was blocked by another client.")),
        { once: true },
      );
    });
  }

  close(): void {
    this.#databaseHandle?.close();
    this.#databaseHandle = null;
    this.#databasePromise = null;
  }

  async pruneExpired(): Promise<number> {
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readwrite");
    const items = transaction.objectStore(ITEMS_STORE);
    const allItems = (await request(items.getAll())) as TelemetryOutboxItem[];
    const now = this.#clock.now();
    const expired = allItems.filter((item) => item.expiresAt <= now);
    for (const item of expired) {
      await request(items.delete(item.id));
    }
    if (expired.length > 0) {
      await incrementMeta(transaction.objectStore(META_STORE), "droppedCount", expired.length);
    }
    await transactionDone(transaction);
    return expired.length;
  }

  async listDue(limit = 50): Promise<ReadonlyArray<TelemetryOutboxItem>> {
    await this.pruneExpired();
    const database = await this.#database();
    const transaction = database.transaction(ITEMS_STORE, "readonly");
    const allItems = (await request(
      transaction.objectStore(ITEMS_STORE).index("nextAttemptAt").getAll(),
    )) as TelemetryOutboxItem[];
    await transactionDone(transaction);
    return allItems
      .filter((item) => item.nextAttemptAt <= this.#clock.now())
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .slice(0, Math.max(1, limit));
  }

  async markSucceeded(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readwrite");
    const items = transaction.objectStore(ITEMS_STORE);
    for (const id of ids) {
      await request(items.delete(id));
    }
    await setMeta(
      transaction.objectStore(META_STORE),
      "lastSuccessfulSyncAt",
      new Date(this.#clock.now()).toISOString(),
    );
    await setMeta(transaction.objectStore(META_STORE), "lastError", null);
    await transactionDone(transaction);
  }

  async markDropped(ids: ReadonlyArray<string>, error: string): Promise<void> {
    if (ids.length === 0) return;
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readwrite");
    const items = transaction.objectStore(ITEMS_STORE);
    for (const id of ids) {
      await request(items.delete(id));
    }
    const meta = transaction.objectStore(META_STORE);
    await incrementMeta(meta, "droppedCount", ids.length);
    await setMeta(meta, "lastError", error.slice(0, 1_000));
    await transactionDone(transaction);
  }

  async markFailed(
    itemsToRetry: ReadonlyArray<TelemetryOutboxItem>,
    error: string,
    retryAfterMs?: number,
  ): Promise<void> {
    if (itemsToRetry.length === 0) return;
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readwrite");
    const items = transaction.objectStore(ITEMS_STORE);
    const now = this.#clock.now();
    for (const item of itemsToRetry) {
      const delay = retryAfterMs ?? calculateRetryDelay(item.attemptCount + 1, this.#random.unit());
      await request(
        items.put({
          ...item,
          attemptCount: item.attemptCount + 1,
          nextAttemptAt: now + delay,
        } satisfies TelemetryOutboxItem),
      );
    }
    await setMeta(transaction.objectStore(META_STORE), "lastError", error.slice(0, 1_000));
    await transactionDone(transaction);
  }

  async recordError(error: string): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(META_STORE, "readwrite");
    await setMeta(transaction.objectStore(META_STORE), "lastError", error.slice(0, 1_000));
    await transactionDone(transaction);
  }

  async status(): Promise<TelemetryOutboxStatus> {
    await this.pruneExpired();
    const database = await this.#database();
    const transaction = database.transaction([ITEMS_STORE, META_STORE], "readonly");
    const items = (await request(
      transaction.objectStore(ITEMS_STORE).getAll(),
    )) as TelemetryOutboxItem[];
    const meta = transaction.objectStore(META_STORE);
    const [lastSuccessfulSyncAt, droppedCount, lastError] = await Promise.all([
      getMeta<string | null>(meta, "lastSuccessfulSyncAt", null),
      getMeta<number>(meta, "droppedCount", 0),
      getMeta<string | null>(meta, "lastError", null),
    ]);
    await transactionDone(transaction);
    const oldest = items.toSorted((left, right) => left.createdAt - right.createdAt)[0];
    return {
      queuedItems: items.length,
      queuedBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      oldestItemAt: oldest ? new Date(oldest.createdAt).toISOString() : null,
      lastSuccessfulSyncAt,
      droppedCount,
      lastError,
    };
  }

  async hasConversationTurn(threadId: string, turnId: string): Promise<boolean> {
    return (await this.#getMeta<boolean>(watermarkKey(threadId, turnId), false)) === true;
  }

  async markConversationTurn(threadId: string, turnId: string): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(META_STORE, "readwrite");
    await setMeta(transaction.objectStore(META_STORE), watermarkKey(threadId, turnId), true);
    await transactionDone(transaction);
  }

  async #getMeta<T>(key: string, fallback: T): Promise<T> {
    const database = await this.#database();
    const transaction = database.transaction(META_STORE, "readonly");
    const value = await getMeta(transaction.objectStore(META_STORE), key, fallback);
    await transactionDone(transaction);
    return value;
  }

  #database(): Promise<IDBDatabase> {
    if (this.#databasePromise) return this.#databasePromise;
    this.#databasePromise = new Promise((resolve, reject) => {
      const open = this.#indexedDB.open(this.#databaseName, DATABASE_VERSION);
      open.onupgradeneeded = () => {
        const database = open.result;
        const items = database.createObjectStore(ITEMS_STORE, { keyPath: "id" });
        items.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
        items.createIndex("category", "category");
        items.createIndex("kind", "kind");
        items.createIndex("createdAt", "createdAt");
        items.createIndex("nextAttemptAt", "nextAttemptAt");
        database.createObjectStore(META_STORE, { keyPath: "key" });
      };
      open.addEventListener(
        "success",
        () => {
          this.#databaseHandle = open.result;
          open.result.addEventListener("versionchange", () => this.close());
          resolve(open.result);
        },
        { once: true },
      );
      open.addEventListener(
        "error",
        () => reject(open.error ?? new Error("Failed to open telemetry outbox.")),
        { once: true },
      );
      open.addEventListener(
        "blocked",
        () => reject(new Error("Telemetry outbox upgrade was blocked.")),
        { once: true },
      );
    });
    return this.#databasePromise;
  }
}

export function calculateRetryDelay(attempt: number, jitterUnit: number): number {
  const exponential = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.max(0, Math.min(1, jitterUnit))));
}

function estimateBytes(input: EnqueueTelemetryInput): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength + 256;
}

function selectCapacityEvictions(
  items: ReadonlyArray<TelemetryOutboxItem>,
  maxBytes: number,
  incoming: TelemetryOutboxItem,
): string[] {
  let total = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (total <= maxBytes) return [];
  const evicted: string[] = [];
  const oldest = (kind: TelemetryOutboxKind) =>
    items
      .filter((item) => item.kind === kind)
      .toSorted((left, right) => left.createdAt - right.createdAt);
  const candidates = [...oldest("replay"), ...oldest("analytics")];
  if (incoming.kind === "conversation") {
    candidates.push(...oldest("conversation"));
  } else {
    candidates.push(incoming);
  }
  for (const item of candidates) {
    if (total <= maxBytes) break;
    if (evicted.includes(item.id)) continue;
    evicted.push(item.id);
    total -= item.sizeBytes;
  }
  return evicted;
}

function watermarkKey(threadId: string, turnId: string): string {
  return `conversation-watermark:${threadId}:${turnId}`;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener("success", () => resolve(value.result), { once: true });
    value.addEventListener(
      "error",
      () => reject(value.error ?? new Error("IndexedDB request failed.")),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
      { once: true },
    );
  });
}

async function getMeta<T>(store: IDBObjectStore, key: string, fallback: T): Promise<T> {
  const row = (await request(store.get(key))) as MetaRow | undefined;
  return row === undefined ? fallback : (row.value as T);
}

async function setMeta(store: IDBObjectStore, key: string, value: unknown): Promise<void> {
  await request(store.put({ key, value } satisfies MetaRow));
}

async function incrementMeta(store: IDBObjectStore, key: string, amount: number): Promise<void> {
  const current = await getMeta<number>(store, key, 0);
  await setMeta(store, key, current + amount);
}
