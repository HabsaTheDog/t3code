import type { PostHogConfig } from "posthog-js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const posthogMocks = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: posthogMocks.init,
  },
}));

import { BrowserPostHogTelemetryClient } from "./posthogClient";

function posthogInstance() {
  const instance = {
    capture: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    reloadFeatureFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
  };
  return { instance };
}

describe("BrowserPostHogTelemetryClient", () => {
  beforeEach(() => {
    posthogMocks.init.mockReset();
  });

  it("uses privacy-preserving SDK controls and buffers sanitized heatmaps", async () => {
    const fake = posthogInstance();
    let config: Partial<PostHogConfig> | undefined;
    posthogMocks.init.mockImplementation((_token, nextConfig: Partial<PostHogConfig>) => {
      config = nextConfig;
      nextConfig.loaded?.(fake.instance as never);
      return fake.instance;
    });
    const client = new BrowserPostHogTelemetryClient();

    await client.initialize({
      host: "https://studybuddyanalytics.habsa.at",
      projectToken: "phc_test",
      installationId: "00000000-0000-4000-8000-000000000001",
    });

    expect(config).toMatchObject({
      api_host: "https://studybuddyanalytics.habsa.at",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      person_profiles: "never",
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      enable_heatmaps: true,
      enable_recording_console_log: false,
      disable_session_recording: true,
      mask_all_text: true,
      autocapture: {
        dom_event_allowlist: ["click"],
        css_selector_allowlist: ["button[data-analytics-id]", "a[data-analytics-id]"],
      },
      bootstrap: {
        distinctID: "00000000-0000-4000-8000-000000000001",
        isIdentifiedID: false,
      },
    });
    expect(fake.instance.startSessionRecording).not.toHaveBeenCalled();
    expect(fake.instance.reloadFeatureFlags).not.toHaveBeenCalled();
  });

  it("keeps recording disabled when analytics is re-enabled", async () => {
    const fake = posthogInstance();
    posthogMocks.init.mockImplementation((_token, config: Partial<PostHogConfig>) => {
      config.loaded?.(fake.instance as never);
      return fake.instance;
    });
    const input = {
      host: "https://studybuddyanalytics.habsa.at",
      projectToken: "phc_test",
      installationId: "00000000-0000-4000-8000-000000000001",
    };

    const client = new BrowserPostHogTelemetryClient();
    await client.initialize(input);
    client.shutdown();
    await client.initialize(input);

    expect(posthogMocks.init).toHaveBeenCalledOnce();
    expect(fake.instance.startSessionRecording).not.toHaveBeenCalled();
    expect(fake.instance.reloadFeatureFlags).not.toHaveBeenCalled();
    expect(fake.instance.stopSessionRecording).toHaveBeenCalledOnce();
    expect(fake.instance.opt_out_capturing).toHaveBeenCalledOnce();
    expect(fake.instance.opt_in_capturing).toHaveBeenCalledTimes(2);
  });

  it("restores the SDK without reinitializing after re-enable", async () => {
    const fake = posthogInstance();
    let config: Partial<PostHogConfig> | undefined;
    posthogMocks.init.mockImplementation((_token, nextConfig: Partial<PostHogConfig>) => {
      config = nextConfig;
      nextConfig.loaded?.(fake.instance as never);
      return fake.instance;
    });
    const client = new BrowserPostHogTelemetryClient();
    const base = {
      host: "https://studybuddyanalytics.habsa.at",
      projectToken: "phc_test",
      installationId: "00000000-0000-4000-8000-000000000001",
    };

    await client.initialize(base);
    client.shutdown();
    await client.initialize(base);
    expect(posthogMocks.init).toHaveBeenCalledOnce();
    expect(config?.autocapture).toMatchObject({
      dom_event_allowlist: ["click"],
      css_selector_allowlist: ["button[data-analytics-id]", "a[data-analytics-id]"],
    });
  });
});
