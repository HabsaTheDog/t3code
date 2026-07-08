import type { TelemetryCategory, TelemetryConsentDecision } from "@t3tools/contracts";

export type {
  ConversationTurnExport,
  TelemetryCategory,
  TelemetryConsentDecision,
  TelemetryOutboxStatus,
} from "@t3tools/contracts";

export type TelemetryOutboxKind = "analytics" | "replay" | "conversation";

export interface TelemetryConsentSnapshot {
  readonly hydrated: boolean;
  readonly installationId: string | null;
  readonly analyticsConsent: TelemetryConsentDecision;
  readonly conversationConsent: TelemetryConsentDecision;
  readonly analyticsEnabledAt: string | null;
  readonly conversationEnabledAt: string | null;
  readonly clearUnconsentedQueue?: boolean;
}

export interface TelemetryOutboxItem {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly category: TelemetryCategory;
  readonly kind: TelemetryOutboxKind;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly sizeBytes: number;
}

export interface SemanticTelemetryEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly timestamp?: string;
}

export interface TelemetryClock {
  readonly now: () => number;
}

export interface TelemetryRandom {
  readonly uuid: () => string;
  readonly unit: () => number;
}

export const systemTelemetryClock: TelemetryClock = {
  now: () => Date.now(),
};

export const systemTelemetryRandom: TelemetryRandom = {
  uuid: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
  unit: () => Math.random(),
};
