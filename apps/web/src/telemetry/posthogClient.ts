import type { PostHog, PostHogConfig } from "posthog-js";

import { PrivacySafeHeatmapCollector } from "./heatmapCollector";

export interface PostHogTelemetryClient {
  readonly initialize: (input: {
    readonly host: string;
    readonly projectToken: string;
    readonly installationId: string;
    readonly beforeSend: NonNullable<PostHogConfig["before_send"]>;
    readonly isActive?: () => boolean;
  }) => Promise<void>;
  readonly capture: (event: string, properties?: Readonly<Record<string, unknown>>) => void;
  readonly getSessionId: (activity?: boolean) => string | null;
  readonly shutdown: () => void;
}

export class BrowserPostHogTelemetryClient implements PostHogTelemetryClient {
  #instance: PostHog | null = null;
  #heatmapCollector: PrivacySafeHeatmapCollector | null = null;

  async initialize(input: {
    readonly host: string;
    readonly projectToken: string;
    readonly installationId: string;
    readonly beforeSend: NonNullable<PostHogConfig["before_send"]>;
    readonly isActive?: () => boolean;
  }): Promise<void> {
    if (input.isActive?.() === false) return;
    // Start the privacy-safe DOM collector before importing PostHog. Product usage data must not
    // disappear when the optional SDK fails to initialize or is reused across a dev/HMR reload.
    this.#startClickCollection(input.beforeSend);
    if (this.#instance) {
      this.#instance.set_config({
        before_send: input.beforeSend,
        capture_heatmaps: false,
        autocapture: false,
      });
      this.#instance.opt_in_capturing({ captureEventName: false });
      return;
    }
    const { default: posthog } = await import("posthog-js");
    if (input.isActive?.() === false) {
      this.#heatmapCollector?.stop();
      this.#heatmapCollector = null;
      return;
    }
    const config: Partial<PostHogConfig> = {
      api_host: input.host,
      ui_host: input.host,
      persistence: "localStorage",
      persistence_name: "study-buddy-telemetry",
      cross_subdomain_cookie: false,
      person_profiles: "never",
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      // Native posthog-js heatmaps always observe mouse movement. The click-only collector below
      // emits the same $$heatmap event format without ever creating movement or scrollmap data.
      capture_heatmaps: false,
      rageclick: false,
      enable_recording_console_log: false,
      // Session replay is intentionally outside the analytics consent contract.
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_feature_flags: false,
      advanced_disable_feature_flags_on_first_load: false,
      save_campaign_params: false,
      save_referrer: false,
      disable_capture_url_hashes: true,
      mask_all_text: true,
      mask_all_element_attributes: false,
      mask_personal_data_properties: true,
      before_send: input.beforeSend,
      // Tagged clicks and click-only heatmaps are collected locally below. Disabling native
      // autocapture avoids SDK lifecycle gaps and guarantees that no DOM text is inspected.
      autocapture: false,
      bootstrap: {
        distinctID: input.installationId,
        isIdentifiedID: false,
      },
      loaded: (instance) => {
        if (input.isActive?.() === false) {
          instance.opt_out_capturing();
          return;
        }
        instance.opt_in_capturing();
      },
    };
    this.#instance = posthog.init(input.projectToken, config);
  }

  capture(event: string, properties?: Readonly<Record<string, unknown>>): void {
    this.#instance?.capture(event, properties);
  }

  getSessionId(activity = false): string | null {
    try {
      if (activity) {
        const activeSession = this.#instance?.sessionManager?.checkAndGetSessionAndWindowId(false);
        if (activeSession?.sessionId) return activeSession.sessionId;
      }
      return this.#instance?.get_session_id() ?? null;
    } catch {
      return null;
    }
  }

  shutdown(): void {
    this.#heatmapCollector?.stop();
    this.#heatmapCollector = null;
    this.#instance?.stopSessionRecording();
    this.#instance?.opt_out_capturing();
    this.#instance?.set_config({ capture_heatmaps: false, autocapture: false });
  }

  #startClickCollection(beforeSend: NonNullable<PostHogConfig["before_send"]>): void {
    this.#heatmapCollector?.stop();
    this.#heatmapCollector = new PrivacySafeHeatmapCollector({
      emit: (properties) => runBeforeSend(beforeSend, { event: "$$heatmap", properties }),
      emitControlClick: (properties) =>
        runBeforeSend(beforeSend, { event: "$autocapture", properties }),
      sessionId: () => this.getSessionId(true),
    });
    this.#heatmapCollector.start();
  }
}

function runBeforeSend(
  beforeSend: NonNullable<PostHogConfig["before_send"]>,
  capture: { readonly event: string; readonly properties: Readonly<Record<string, unknown>> },
): void {
  const sanitizers = Array.isArray(beforeSend) ? beforeSend : [beforeSend];
  let current: unknown = capture;
  for (const sanitizer of sanitizers) {
    if (!current) return;
    current = sanitizer(current as never);
  }
}
