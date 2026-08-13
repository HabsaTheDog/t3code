import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TelemetryController } from "./controller";
import { TelemetryOutbox } from "./outbox";
import type { PostHogTelemetryClient } from "./posthogClient";
import type { TelemetryConsentSnapshot } from "./types";

function consent(patch: Partial<TelemetryConsentSnapshot> = {}): TelemetryConsentSnapshot {
  return {
    hydrated: true,
    installationId: "install-id",
    analyticsConsent: "unset",
    conversationConsent: "unset",
    analyticsEnabledAt: null,
    conversationEnabledAt: null,
    ...patch,
  };
}

function posthogSpy() {
  return {
    initialize: vi.fn<PostHogTelemetryClient["initialize"]>(async () => undefined),
    capture: vi.fn(),
    getSessionId: vi.fn(() => "0198a748-305a-7000-8000-000000000001"),
    shutdown: vi.fn(),
  } satisfies PostHogTelemetryClient;
}

function outboxFactory() {
  let nextId = 0;
  return () =>
    new TelemetryOutbox({
      indexedDB: new IDBFactory(),
      databaseName: `controller-test-${Math.random()}`,
      clock: { now: () => Date.parse("2026-06-27T10:01:00.000Z") },
      random: {
        uuid: () => `queue-${++nextId}`,
        unit: () => 0.5,
      },
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelemetryController consent lifecycle", () => {
  it("accepts every bounded voice lifecycle event after analytics consent", async () => {
    const controller = new TelemetryController({
      createOutbox: outboxFactory(),
      posthogClient: posthogSpy(),
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    const events = [
      "speech.model.install_started",
      "speech.model.install_completed",
      "speech.model.install_failed",
      "speech.model.removed",
      "speech.model.remove_failed",
      "speech.recording.started",
      "speech.recording.discarded",
      "speech.transcription.completed",
      "speech.transcription.failed",
      "speech.voice_note.removed",
      "speech.voice_message.sent",
    ] as const;

    await expect(
      Promise.all(events.map((event) => controller.capture({ event }))),
    ).resolves.toEqual(events.map(() => true));
    await expect(controller.diagnostics()).resolves.toMatchObject({ queuedItems: events.length });
    controller.stop();
  });

  it("keeps a fresh client silent with the production SDK boundary configured", async () => {
    const fetchSpy = vi.fn();
    const localStorage = {
      get length(): number {
        throw new Error("localStorage must not be inspected before consent");
      },
      clear: vi.fn(() => {
        throw new Error("localStorage must not be changed before consent");
      }),
      getItem: vi.fn(() => {
        throw new Error("localStorage must not be inspected before consent");
      }),
      key: vi.fn(() => {
        throw new Error("localStorage must not be inspected before consent");
      }),
      removeItem: vi.fn(() => {
        throw new Error("localStorage must not be changed before consent");
      }),
      setItem: vi.fn(() => {
        throw new Error("localStorage must not be changed before consent");
      }),
    } satisfies Storage;
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => {
        throw new Error("IndexedDB must not open before consent");
      }),
      deleteDatabase: vi.fn(() => {
        throw new Error("IndexedDB must not change before consent");
      }),
    });

    const controller = new TelemetryController({
      projectToken: "phc_production-configured",
    });

    await controller.hydrate(consent());
    await controller.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
    controller.stop();
  });

  it("does not create storage, initialize the SDK, or perform network before consent", async () => {
    const createOutbox = vi.fn(outboxFactory());
    const posthog = posthogSpy();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox,
      posthogClient: posthog,
    });

    await controller.hydrate(consent());
    expect(createOutbox).not.toHaveBeenCalled();
    expect(posthog.initialize).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(controller.diagnostics()).resolves.toEqual({
      queuedItems: 0,
      queuedBytes: 0,
      oldestItemAt: null,
      lastSuccessfulSyncAt: null,
      droppedCount: 0,
      lastError: null,
    });
  });

  it("initializes PostHog only after hydrated analytics acceptance and a token", async () => {
    const posthog = posthogSpy();
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    expect(posthog.initialize).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("routes sanitized SDK heatmaps through the consent-gated durable uploader", async () => {
    const posthog = posthogSpy();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
      clock: { now: () => Date.parse("2026-06-27T10:01:00.000Z") },
      random: { uuid: () => `sdk-${Math.random()}`, unit: () => 0.5 },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    const initializeInput = posthog.initialize.mock.calls[0]?.[0];
    expect(initializeInput?.beforeSend).toEqual(expect.any(Function));
    const beforeSend = initializeInput?.beforeSend;
    if (typeof beforeSend !== "function") throw new Error("before_send was not configured");

    expect(
      beforeSend({
        event: "$$heatmap",
        properties: {
          $viewport_width: 1440,
          $viewport_height: 900,
          $heatmap_data: {
            "https://private.test/chat/thread-secret?token=secret": [
              { x: 12, y: 34, type: "click", text: "CANARY_PROMPT" },
              { x: 56, y: 78, type: "mousemove" },
            ],
          },
        },
      } as never),
    ).toBeNull();

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const request = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    expect(body.batch).toEqual([
      expect.objectContaining({
        event: "$$heatmap",
        properties: expect.objectContaining({
          distinct_id: "install-id",
          telemetry_schema_version: 6,
          sdk_event_source: "posthog-js",
          $viewport_width: 1440,
          $viewport_height: 900,
          $heatmap_data: {
            "https://app.t3.codes/_chat/": [{ x: 12, y: 34, type: "click" }],
          },
        }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("private.test");
    expect(JSON.stringify(body)).not.toContain("thread-secret");
    expect(JSON.stringify(body)).not.toContain("CANARY_PROMPT");
    expect(JSON.stringify(body)).not.toContain("mousemove");
    controller.stop();
  });

  it("uploads native pageviews and semantic events with one privacy-safe session context", async () => {
    const posthog = posthogSpy();
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
      clock: { now: () => Date.parse("2026-06-27T10:01:00.000Z") },
      random: { uuid: () => `pageview-${Math.random()}`, unit: () => 0.5 },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );

    await expect(
      controller.capturePageview(
        "/_chat/environment-secret/thread-secret?token=private#conversation",
      ),
    ).resolves.toBe(true);
    await expect(
      controller.capture({
        event: "feature.used",
        properties: { feature: "thread.favorite" },
      }),
    ).resolves.toBe(true);
    await controller.flush();

    const batches = fetchSpy.mock.calls.flatMap(([, request]) => {
      if (typeof request?.body !== "string") return [];
      return (JSON.parse(request.body) as { batch?: unknown[] }).batch ?? [];
    }) as Array<{ event: string; properties: Record<string, unknown> }>;
    expect(batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "$pageview",
          properties: expect.objectContaining({
            route: "chat",
            $current_url: "https://app.t3.codes/_chat/",
            $session_id: "0198a748-305a-7000-8000-000000000001",
            telemetry_schema_version: 6,
          }),
        }),
        expect.objectContaining({
          event: "feature.used",
          properties: expect.objectContaining({
            feature: "thread.favorite",
            $session_id: "0198a748-305a-7000-8000-000000000001",
          }),
        }),
      ]),
    );
    const serialized = JSON.stringify(batches);
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("thread-secret");
    expect(serialized).not.toContain("token=private");
    controller.stop();
  });

  it("rejects native pageviews submitted through the public semantic-event boundary", async () => {
    const controller = new TelemetryController({
      createOutbox: outboxFactory(),
      posthogClient: posthogSpy(),
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );

    await expect(
      controller.capture({
        event: "$pageview",
        properties: { $current_url: "https://private.test/thread-secret?token=private" },
      }),
    ).resolves.toBe(false);
    await expect(controller.diagnostics()).resolves.toMatchObject({ queuedItems: 0 });
    controller.stop();
  });

  it("queues future analytics without a production token and never initializes the SDK", async () => {
    const posthog = posthogSpy();
    const controller = new TelemetryController({
      projectToken: "",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
      random: { uuid: () => "event-id", unit: () => 0.5 },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await expect(
      controller.capture({
        event: "feature.used",
        properties: { feature: "privacy" },
      }),
    ).resolves.toBe(true);
    expect(posthog.initialize).not.toHaveBeenCalled();
    expect(await controller.diagnostics()).toMatchObject({ queuedItems: 1 });
  });

  it("uploads conversation-only consent without importing or initializing PostHog", async () => {
    const posthog = posthogSpy();
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
    });
    await controller.hydrate(
      consent({
        conversationConsent: "accepted",
        conversationEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await controller.exportConversationTurn({
      idempotencyKey: "conversation:thread:turn",
      installationId: "ignored-by-controller",
      threadId: "thread",
      turnId: "turn",
      aiSessionId: "thread",
      aiTraceId: "turn",
      userText: "Question",
      assistantText: "Answer",
      provider: "codex",
      model: "gpt-5",
      startedAt: "2026-06-27T10:00:01.000Z",
      completedAt: "2026-06-27T10:00:02.000Z",
      latencyMs: 1_000,
      state: "success",
    });
    await controller.flush();
    expect(fetchSpy).toHaveBeenCalled();
    expect(posthog.initialize).not.toHaveBeenCalled();
    controller.stop();
  });

  it("keeps rating and optional written feedback behind their independent consent gates", async () => {
    const controller = new TelemetryController({
      projectToken: "",
      createOutbox: outboxFactory(),
      posthogClient: posthogSpy(),
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
      random: { uuid: () => `feedback-${Math.random()}`, unit: () => 0.5 },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        conversationConsent: "rejected",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await expect(
      controller.submitResponseFeedback({
        threadId: "thread",
        turnId: "turn",
        rating: "negative",
        note: "Needs a source.",
      }),
    ).resolves.toEqual({ ratingCaptured: true, noteCaptured: false });

    await controller.updateConsent(
      consent({
        analyticsConsent: "accepted",
        conversationConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
        conversationEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await expect(
      controller.submitResponseFeedback({
        threadId: "thread",
        turnId: "turn",
        rating: "negative",
        note: "Needs a source.",
      }),
    ).resolves.toEqual({ ratingCaptured: false, noteCaptured: true });
    expect(await controller.diagnostics()).toMatchObject({ queuedItems: 3 });
  });

  it("clears only the disabled category queue", async () => {
    const controller = new TelemetryController({
      createOutbox: outboxFactory(),
      posthogClient: posthogSpy(),
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
      random: { uuid: () => `id-${Math.random()}`, unit: () => 0.5 },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        conversationConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
        conversationEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await controller.capture({ event: "app.started" });
    await controller.exportConversationTurn({
      idempotencyKey: "conversation:thread:turn",
      installationId: "install-id",
      threadId: "thread",
      turnId: "turn",
      aiSessionId: "thread",
      aiTraceId: "turn",
      userText: "Question",
      assistantText: "Answer",
      provider: "codex",
      model: "gpt-5",
      startedAt: "2026-06-27T10:00:01.000Z",
      completedAt: "2026-06-27T10:00:02.000Z",
      latencyMs: 1_000,
      state: "success",
    });
    await controller.updateConsent(
      consent({
        analyticsConsent: "rejected",
        conversationConsent: "accepted",
        conversationEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    expect(await controller.diagnostics()).toMatchObject({ queuedItems: 1 });
  });

  it("deletes the persisted outbox when every category is rejected", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "controller-delete-all";
    const createOutbox = () =>
      new TelemetryOutbox({
        indexedDB,
        databaseName,
        random: { uuid: () => `id-${Math.random()}`, unit: () => 0.5 },
      });
    const controller = new TelemetryController({
      createOutbox,
      posthogClient: posthogSpy(),
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await controller.capture({ event: "app.started" });
    await controller.updateConsent(
      consent({ analyticsConsent: "rejected", conversationConsent: "rejected" }),
    );

    expect(await createOutbox().status()).toMatchObject({ queuedItems: 0 });
  });

  it("deletes queued events when an accepted choice is deferred back to unset", async () => {
    const controller = new TelemetryController({
      createOutbox: outboxFactory(),
      posthogClient: posthogSpy(),
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
    });
    await controller.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await controller.capture({ event: "app.started" });
    expect(await controller.diagnostics()).toMatchObject({ queuedItems: 1 });

    await controller.updateConsent(consent());

    expect(await controller.diagnostics()).toMatchObject({ queuedItems: 0 });
  });

  it("deletes queues from an obsolete consent version during the next hydration", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "obsolete-consent-queue";
    const createOutbox = () =>
      new TelemetryOutbox({
        indexedDB,
        databaseName,
        random: { uuid: () => `id-${Math.random()}`, unit: () => 0.5 },
      });
    const previousRuntime = new TelemetryController({
      createOutbox,
      posthogClient: posthogSpy(),
      clock: { now: () => Date.parse("2026-06-27T10:00:01.000Z") },
    });
    await previousRuntime.hydrate(
      consent({
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await previousRuntime.capture({ event: "app.started" });
    previousRuntime.stop();

    const nextRuntime = new TelemetryController({
      createOutbox,
      posthogClient: posthogSpy(),
    });
    await nextRuntime.hydrate(
      consent({
        installationId: "install-id",
        clearUnconsentedQueue: true,
      }),
    );

    expect(await createOutbox().status()).toMatchObject({ queuedItems: 0 });
  });

  it("does not initialize a stale accepted reconcile after consent is withdrawn", async () => {
    let releaseInstallationId!: () => void;
    const installationIdPersisted = new Promise<void>((resolve) => {
      releaseInstallationId = resolve;
    });
    const persistenceStarted = vi.fn();
    const posthog = posthogSpy();
    const controller = new TelemetryController({
      projectToken: "phc_test",
      createOutbox: outboxFactory(),
      posthogClient: posthog,
      random: { uuid: () => "generated-installation-id", unit: () => 0.5 },
      onInstallationIdCreated: async () => {
        persistenceStarted();
        await installationIdPersisted;
      },
    });

    const accepting = controller.hydrate(
      consent({
        installationId: null,
        analyticsConsent: "accepted",
        analyticsEnabledAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    await vi.waitFor(() => expect(persistenceStarted).toHaveBeenCalledOnce());
    const withdrawing = controller.updateConsent(
      consent({ installationId: "generated-installation-id", analyticsConsent: "rejected" }),
    );
    releaseInstallationId();
    await Promise.all([accepting, withdrawing]);

    expect(posthog.initialize).not.toHaveBeenCalled();
    expect(posthog.shutdown).toHaveBeenCalled();
  });
});
