import { describe, expect, it, vi } from "vite-plus/test";

import { PrivacySafeHeatmapCollector } from "./heatmapCollector";

function collectorHarness() {
  let clickListener: ((event: Event) => void) | undefined;
  const document = {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "click" && typeof listener === "function") clickListener = listener;
    }),
    removeEventListener: vi.fn(),
  };
  const emit = vi.fn();
  const emitControlClick = vi.fn();
  const collector = new PrivacySafeHeatmapCollector({
    emit,
    emitControlClick,
    document: document as never,
    window: {
      location: { href: "https://private.test/_chat/environment-secret/thread-secret?token=x" },
      innerWidth: 1440,
      innerHeight: 900,
      scrollX: 4,
      scrollY: 8,
      getComputedStyle: vi.fn(() => ({ position: "static" })) as never,
    },
    intervalMs: 60_000,
    sessionId: () => "0198a748-305a-7000-8000-000000000001",
  });
  return {
    collector,
    document,
    emit,
    emitControlClick,
    click: (event: object) => clickListener?.(event as Event),
  };
}

describe("PrivacySafeHeatmapCollector", () => {
  it("collects only click coordinates under a canonical app route", () => {
    const { collector, emit, click } = collectorHarness();
    collector.start();
    click({ clientX: 10, clientY: 20, pageX: 14, pageY: 28 });
    click({ clientX: Number.NaN, clientY: 20 });
    collector.flush();

    expect(emit).toHaveBeenCalledWith({
      $heatmap_data: {
        "https://app.t3.codes/_chat/": [{ x: 14, y: 28, type: "click", target_fixed: false }],
      },
      $viewport_width: 1440,
      $viewport_height: 900,
      $session_id: "0198a748-305a-7000-8000-000000000001",
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private.test");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("thread-secret");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("token=x");
    collector.stop();
  });

  it("captures tagged controls without reading DOM text or attributes", () => {
    const { collector, emitControlClick, click } = collectorHarness();
    const parent = {
      getAttribute: (name: string) => (name === "data-analytics-id" ? "thread.favorite" : null),
      parentElement: null,
      textContent: "private thread title",
    };
    collector.start();
    click({
      clientX: 10,
      clientY: 20,
      target: {
        getAttribute: () => null,
        parentElement: parent,
        value: "private input",
      },
    });

    expect(emitControlClick).toHaveBeenCalledWith({
      analytics_id: "thread.favorite",
      $current_url: "https://app.t3.codes/_chat/",
      $session_id: "0198a748-305a-7000-8000-000000000001",
    });
    expect(JSON.stringify(emitControlClick.mock.calls)).not.toContain("private thread title");
    expect(JSON.stringify(emitControlClick.mock.calls)).not.toContain("private input");
    collector.stop();
  });

  it("removes the click listener and discards unsent points when stopped", () => {
    const { collector, document, emit, click } = collectorHarness();
    collector.start();
    click({ clientX: 10, clientY: 20, pageX: 10, pageY: 20 });
    collector.stop();
    collector.flush();

    expect(document.removeEventListener).toHaveBeenCalledWith("click", expect.any(Function), {
      capture: true,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});
