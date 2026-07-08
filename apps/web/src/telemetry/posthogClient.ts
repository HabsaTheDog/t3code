import type { PostHog, PostHogConfig } from "posthog-js";

export interface PostHogTelemetryClient {
  readonly initialize: (input: {
    readonly host: string;
    readonly projectToken: string;
    readonly installationId: string;
    readonly isActive?: () => boolean;
  }) => Promise<void>;
  readonly capture: (event: string, properties?: Readonly<Record<string, unknown>>) => void;
  readonly shutdown: () => void;
}

export class BrowserPostHogTelemetryClient implements PostHogTelemetryClient {
  #instance: PostHog | null = null;

  async initialize(input: {
    readonly host: string;
    readonly projectToken: string;
    readonly installationId: string;
    readonly isActive?: () => boolean;
  }): Promise<void> {
    if (input.isActive?.() === false) return;
    if (this.#instance) {
      this.#instance.opt_in_capturing({ captureEventName: false });
      return;
    }
    const { default: posthog } = await import("posthog-js");
    if (input.isActive?.() === false) return;
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
      enable_heatmaps: true,
      rageclick: false,
      enable_recording_console_log: false,
      // A recording must not start until remote recording controls have been
      // fetched successfully at least once. #armSessionRecording lifts this.
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_feature_flags: false,
      advanced_disable_feature_flags_on_first_load: false,
      save_campaign_params: false,
      save_referrer: false,
      disable_capture_url_hashes: true,
      mask_all_text: true,
      mask_all_element_attributes: false,
      autocapture: {
        dom_event_allowlist: ["click"],
        css_selector_allowlist: ["button[data-analytics-id]", "a[data-analytics-id]"],
      },
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

  shutdown(): void {
    this.#instance?.stopSessionRecording();
    this.#instance?.opt_out_capturing();
  }
}
