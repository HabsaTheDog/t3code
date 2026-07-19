import { ConversationExporter } from "./conversation";
import { TelemetryOutbox, type TelemetryOutboxOptions } from "./outbox";
import { BrowserPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthogClient";
import { PostHogBatchUploader, TelemetryRetryWorker } from "./retryWorker";
import { sanitizeRecord } from "./sanitize";
import {
  systemTelemetryClock,
  systemTelemetryRandom,
  type ConversationTurnExport,
  type SemanticTelemetryEvent,
  type TelemetryClock,
  type TelemetryConsentSnapshot,
  type TelemetryOutboxStatus,
  type TelemetryRandom,
} from "./types";

export const DEFAULT_POSTHOG_HOST = "https://studybuddyanalytics.habsa.at";

const SEMANTIC_EVENTS = new Set([
  "app.started",
  "route.viewed",
  "setup.step_viewed",
  "setup.step_completed",
  "setup.step_skipped",
  "setup.step_failed",
  "provider.install_started",
  "provider.install_completed",
  "provider.install_failed",
  "provider.auth_started",
  "provider.auth_completed",
  "provider.auth_failed",
  "study_connection.tested",
  "thread.created",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "orchestration.task.completed",
  "feature.used",
  "settings.changed",
]);

const EMPTY_STATUS: TelemetryOutboxStatus = {
  queuedItems: 0,
  queuedBytes: 0,
  oldestItemAt: null,
  lastSuccessfulSyncAt: null,
  droppedCount: 0,
  lastError: null,
};

export interface TelemetryControllerOptions {
  readonly posthogHost?: string;
  readonly projectToken?: string;
  readonly configuredSecrets?: () => ReadonlyArray<string>;
  readonly onInstallationIdCreated?: (installationId: string) => void | Promise<void>;
  readonly outboxOptions?: TelemetryOutboxOptions;
  readonly createOutbox?: () => TelemetryOutbox;
  readonly posthogClient?: PostHogTelemetryClient;
  readonly clock?: TelemetryClock;
  readonly random?: TelemetryRandom;
}

export class TelemetryController {
  readonly #host: string;
  readonly #projectToken: string;
  readonly #configuredSecrets: () => ReadonlyArray<string>;
  readonly #onInstallationIdCreated: ((installationId: string) => void | Promise<void>) | undefined;
  readonly #createOutbox: () => TelemetryOutbox;
  readonly #posthog: PostHogTelemetryClient;
  readonly #clock: TelemetryClock;
  readonly #random: TelemetryRandom;
  #settings: TelemetryConsentSnapshot | null = null;
  #installationId: string | null = null;
  #outbox: TelemetryOutbox | null = null;
  #worker: TelemetryRetryWorker | null = null;
  #conversationExporter: ConversationExporter | null = null;
  #analyticsInitialized = false;
  #analyticsGeneration = 0;
  #consentRevision = 0;
  #reconcileQueue: Promise<void> = Promise.resolve();
  #lastLifecycleError: string | null = null;

  constructor(options: TelemetryControllerOptions = {}) {
    this.#host = options.posthogHost ?? DEFAULT_POSTHOG_HOST;
    this.#projectToken = options.projectToken?.trim() ?? "";
    this.#configuredSecrets = options.configuredSecrets ?? (() => []);
    this.#onInstallationIdCreated = options.onInstallationIdCreated;
    this.#createOutbox = options.createOutbox ?? (() => new TelemetryOutbox(options.outboxOptions));
    this.#posthog = options.posthogClient ?? new BrowserPostHogTelemetryClient();
    this.#clock = options.clock ?? systemTelemetryClock;
    this.#random = options.random ?? systemTelemetryRandom;
  }

  async hydrate(settings: TelemetryConsentSnapshot): Promise<void> {
    const revision = ++this.#consentRevision;
    this.#settings = settings;
    if (!settings.hydrated) return;
    this.#installationId = settings.installationId;
    await this.#queueReconcile(revision);
  }

  async updateConsent(settings: TelemetryConsentSnapshot): Promise<void> {
    if (!settings.hydrated) {
      throw new Error("Telemetry consent cannot change before client settings hydrate.");
    }
    const revision = ++this.#consentRevision;
    const previous = this.#settings;
    this.#settings = settings;
    if (settings.installationId) this.#installationId = settings.installationId;
    if (settings.analyticsConsent !== "accepted") {
      this.#analyticsGeneration += 1;
      this.#posthog.shutdown();
      this.#analyticsInitialized = false;
    }
    if (
      previous?.analyticsConsent === "accepted" &&
      settings.analyticsConsent !== "accepted" &&
      this.#outbox
    ) {
      await this.#clearCategory(this.#outbox, "analytics");
    }
    if (
      previous?.conversationConsent === "accepted" &&
      settings.conversationConsent !== "accepted" &&
      this.#outbox
    ) {
      await this.#clearCategory(this.#outbox, "conversation");
    }
    await this.#queueReconcile(revision);
  }

  async capture(event: SemanticTelemetryEvent): Promise<boolean> {
    const settings = this.#settings;
    if (
      !settings?.hydrated ||
      settings.analyticsConsent !== "accepted" ||
      settings.analyticsEnabledAt === null ||
      !SEMANTIC_EVENTS.has(event.event)
    ) {
      return false;
    }
    const timestamp = event.timestamp ? Date.parse(event.timestamp) : this.#clock.now();
    const enabledAt = Date.parse(settings.analyticsEnabledAt);
    if (!Number.isFinite(timestamp) || !Number.isFinite(enabledAt) || timestamp < enabledAt) {
      return false;
    }
    try {
      const installationId = await this.#ensureInstallationId();
      const outbox = this.#ensureOutbox();
      const result = await outbox.enqueue({
        category: "analytics",
        kind: "analytics",
        event: event.event,
        idempotencyKey: event.idempotencyKey ?? this.#random.uuid(),
        payload: {
          distinct_id: installationId,
          ...sanitizeRecord(event.properties ?? {}, this.#configuredSecrets()),
        },
        createdAt: timestamp,
      });
      if (result === "enqueued") void this.#worker?.flush();
      return result === "enqueued";
    } catch {
      return false;
    }
  }

  async exportConversationTurn(turn: ConversationTurnExport): Promise<boolean> {
    const settings = this.#settings;
    if (!settings?.hydrated || settings.conversationConsent !== "accepted") return false;
    try {
      const installationId = await this.#ensureInstallationId();
      const exporter = this.#ensureConversationExporter();
      const exported = await exporter.exportCompletedTurn({
        ...turn,
        installationId,
      });
      if (exported) void this.#worker?.flush();
      return exported;
    } catch {
      return false;
    }
  }

  async diagnostics(): Promise<TelemetryOutboxStatus> {
    if (!this.#outbox) {
      return this.#lastLifecycleError
        ? { ...EMPTY_STATUS, lastError: this.#lastLifecycleError }
        : EMPTY_STATUS;
    }
    return this.#outbox
      .status()
      .then((status) => ({
        ...status,
        lastError: this.#lastLifecycleError ?? status.lastError,
      }))
      .catch((error) => ({
        ...EMPTY_STATUS,
        lastError:
          this.#lastLifecycleError ??
          (error instanceof Error ? error.message : "Telemetry outbox unavailable."),
      }));
  }

  async flush(): Promise<void> {
    await this.#worker?.flush();
  }

  stop(): void {
    this.#analyticsGeneration += 1;
    this.#worker?.stop();
    this.#worker = null;
    this.#posthog.shutdown();
    this.#analyticsInitialized = false;
    this.#outbox?.close();
    this.#outbox = null;
    this.#conversationExporter = null;
  }

  #queueReconcile(revision: number): Promise<void> {
    const reconciliation = this.#reconcileQueue.then(() => this.#reconcile(revision));
    this.#reconcileQueue = reconciliation.catch(() => undefined);
    return reconciliation.catch(() => undefined);
  }

  async #reconcile(revision: number): Promise<void> {
    if (revision !== this.#consentRevision) return;
    const settings = this.#settings;
    if (!settings?.hydrated) return;
    const analyticsAccepted = settings.analyticsConsent === "accepted";
    const conversationAccepted = settings.conversationConsent === "accepted";

    if (!analyticsAccepted) {
      this.#analyticsGeneration += 1;
      this.#posthog.shutdown();
      this.#analyticsInitialized = false;
    }
    if (!analyticsAccepted && !conversationAccepted) {
      this.#worker?.stop();
      this.#worker = null;
      if (
        settings.clearUnconsentedQueue === true ||
        settings.analyticsConsent === "rejected" ||
        settings.conversationConsent === "rejected"
      ) {
        const outbox = this.#outbox ?? this.#createOutbox();
        const deleted = await outbox
          .deleteAll()
          .then(() => true)
          .catch(() => {
            this.#lastLifecycleError = "Failed to delete the disabled telemetry queue.";
            return false;
          });
        if (deleted) {
          this.#lastLifecycleError = null;
          this.#outbox = null;
          this.#conversationExporter = null;
        }
      }
      return;
    }

    const installationId = await this.#ensureInstallationId();
    if (revision !== this.#consentRevision) return;
    const outbox = this.#ensureOutbox();
    if (!analyticsAccepted) {
      await this.#clearCategory(outbox, "analytics");
    }
    if (!conversationAccepted) {
      await this.#clearCategory(outbox, "conversation");
    }
    if (this.#projectToken && !this.#worker) {
      if (revision !== this.#consentRevision) return;
      this.#worker = new TelemetryRetryWorker(
        outbox,
        new PostHogBatchUploader({
          host: this.#host,
          projectToken: this.#projectToken,
        }),
        {
          shouldUpload: (item) =>
            item.category === "analytics"
              ? this.#settings?.analyticsConsent === "accepted"
              : this.#settings?.conversationConsent === "accepted",
        },
      );
      this.#worker.start();
    }
    if (analyticsAccepted && this.#projectToken && !this.#analyticsInitialized) {
      if (revision !== this.#consentRevision) return;
      const generation = ++this.#analyticsGeneration;
      await this.#posthog.initialize({
        host: this.#host,
        projectToken: this.#projectToken,
        installationId,
        isActive: () =>
          revision === this.#consentRevision &&
          generation === this.#analyticsGeneration &&
          this.#settings?.analyticsConsent === "accepted",
      });
      if (
        generation === this.#analyticsGeneration &&
        this.#settings?.analyticsConsent === "accepted"
      ) {
        this.#analyticsInitialized = true;
      } else {
        this.#posthog.shutdown();
        this.#analyticsInitialized = false;
      }
    }
  }

  async #ensureInstallationId(): Promise<string> {
    if (this.#installationId) return this.#installationId;
    const installationId = this.#random.uuid();
    this.#installationId = installationId;
    await this.#onInstallationIdCreated?.(installationId);
    return installationId;
  }

  #ensureOutbox(): TelemetryOutbox {
    this.#outbox ??= this.#createOutbox();
    return this.#outbox;
  }

  #ensureConversationExporter(): ConversationExporter {
    this.#conversationExporter ??= new ConversationExporter(this.#ensureOutbox(), {
      consent: () => ({
        decision: this.#settings?.conversationConsent ?? "unset",
        enabledAt: this.#settings?.conversationEnabledAt ?? null,
      }),
      configuredSecrets: this.#configuredSecrets,
    });
    return this.#conversationExporter;
  }

  async #clearCategory(outbox: TelemetryOutbox, category: "analytics" | "conversation") {
    await outbox
      .clearCategory(category)
      .then(() => {
        this.#lastLifecycleError = null;
      })
      .catch(async () => {
        this.#lastLifecycleError = `Failed to delete the disabled ${category} queue.`;
        await outbox.recordError(this.#lastLifecycleError).catch(() => undefined);
      });
  }
}
