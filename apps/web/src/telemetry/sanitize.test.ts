import { describe, expect, it, vi } from "vite-plus/test";

import {
  makeBeforeSendSanitizer,
  redactSensitiveText,
  sanitizeRecord,
  sanitizeReplayPayload,
} from "./sanitize";

describe("telemetry sanitization", () => {
  it("redacts credentials and configured secrets deterministically", () => {
    const result = redactSensitiveText(
      "Authorization: Bearer abcdefghijklmnop password=hunter2 webcal://calendar/private",
      ["hunter2"],
    );
    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("webcal://");
  });

  it("redacts JWTs, cookie assignments, and common provider token formats", () => {
    const value =
      "cookie=sensitive eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature ghp_abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSensitiveText(value);
    expect(result).not.toContain("sensitive");
    expect(result).not.toContain("eyJ");
    expect(result).not.toContain("ghp_");
  });

  it("redacts current OpenAI and Anthropic API key formats", () => {
    const result = redactSensitiveText(
      "openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456 anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(result).not.toContain("sk-proj-");
    expect(result).not.toContain("sk-ant-");
    expect(result).toContain("[REDACTED_KEY]");
  });

  it("strips URLs, paths, arbitrary attributes, text and values from analytics", () => {
    expect(
      sanitizeRecord({
        route: "settings",
        url: "https://example.test/private?token=x",
        filename: "/home/alice/secret.ts",
        text: "prompt",
        message: "entered conversation",
        content: "assistant output",
        value: "password",
        arbitrarySafeCount: 2,
        error: "failed at /home/alice/secret.ts via https://private.example/a?q=1",
      }),
    ).toEqual({
      route: "settings",
      arbitrarySafeCount: 2,
      error: "failed at [REDACTED_PATH] via [REDACTED_URL]",
    });
  });

  it("removes canary content from replay payloads before enqueue", () => {
    const payload = sanitizeReplayPayload({
      $snapshot_data: {
        text: "CANARY_PROMPT",
        value: "CANARY_PASSWORD",
        attributes: {
          class: "grid gap-2",
          style: "display: grid",
          title: "CANARY_API_KEY",
        },
      },
      $browser: "Should not be collected",
    });
    expect(JSON.stringify(payload)).not.toContain("CANARY");
    expect(payload).toEqual({
      $snapshot_data: {
        text: "[REDACTED]",
        value: "[REDACTED]",
        attributes: { class: "grid gap-2", style: "display: grid" },
      },
    });
  });

  it("removes nested composer, transcript, terminal, and credential canaries from replay", () => {
    const payload = sanitizeReplayPayload(
      {
        $session_id: "session-safe",
        $window_id: "window-safe",
        $snapshot_data: {
          type: 2,
          data: {
            node: {
              type: 2,
              tagName: "div",
              attributes: {
                class: "ph-no-capture terminal CANARY_CONFIGURED_SECRET",
                "aria-label": "CANARY_TRANSCRIPT",
                title: "CANARY_PASSWORD",
                value: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
              },
              childNodes: [
                {
                  type: 3,
                  textContent: "CANARY_PROMPT",
                },
                {
                  type: 2,
                  tagName: "input",
                  attributes: {
                    class: "credential-form",
                    value: "CANARY_PASSWORD",
                  },
                },
              ],
            },
            terminal: "CANARY_TERMINAL",
            href: "https://user:password@example.test/private",
          },
        },
      },
      ["CANARY_CONFIGURED_SECRET"],
    );

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("CANARY_PROMPT");
    expect(serialized).not.toContain("CANARY_TRANSCRIPT");
    expect(serialized).not.toContain("CANARY_TERMINAL");
    expect(serialized).not.toContain("CANARY_PASSWORD");
    expect(serialized).not.toContain("CANARY_CONFIGURED_SECRET");
    expect(serialized).not.toContain("sk-proj-");
    expect(serialized).not.toContain("user:password");
    expect(payload).toMatchObject({
      $session_id: "session-safe",
      $window_id: "window-safe",
      $snapshot_data: {
        data: {
          terminal: "[REDACTED]",
          href: "[REDACTED]",
        },
      },
    });
  });

  it("removes paths and fenced diffs from shared conversation text", () => {
    const result = redactSensitiveText("See /home/alice/private.ts\n```diff\n-secret\n+token\n```");
    expect(result).not.toContain("/home/alice");
    expect(result).not.toContain("-secret");
    expect(result).toContain("[REDACTED_PATH]");
    expect(result).toContain("[REDACTED_DIFF]");
  });

  it("queues sanitized SDK events and always cancels direct SDK delivery", () => {
    const enqueue = vi.fn();
    const beforeSend = makeBeforeSendSanitizer({ enqueue });
    expect(
      beforeSend({
        event: "$autocapture",
        properties: { url: "https://private.test", analytics_id: "settings-save" },
      }),
    ).toBeNull();
    expect(enqueue).toHaveBeenCalledWith("$autocapture", {
      analytics_id: "settings-save",
      event_type: "click",
    });
  });

  it("accepts the SDK heatmap event name and strips buffered page URLs", async () => {
    const enqueue = vi.fn();
    const beforeSend = makeBeforeSendSanitizer({ enqueue });

    beforeSend({
      event: "$$heatmap",
      properties: {
        $heatmap_data: {
          "https://example.test/chat/thread-secret?token=secret": [{ x: 10, y: 20, type: "click" }],
        },
      },
    });
    await Promise.resolve();

    expect(enqueue).toHaveBeenCalledWith("$$heatmap", {
      $heatmap_data: {
        "https://studybuddy.local/:segment/:segment": [{ x: 10, y: 20, type: "click" }],
      },
    });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("thread-secret");
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("token=secret");
  });

  it("sanitizes realistic heatmap point metadata at the SDK outbox boundary", async () => {
    const enqueue = vi.fn();
    const beforeSend = makeBeforeSendSanitizer({
      configuredSecrets: () => ["configured-secret"],
      enqueue,
    });

    const directDelivery = beforeSend({
      event: "$$heatmap",
      properties: {
        $session_id: "session-safe",
        $window_id: "window-safe",
        $current_url: "https://example.test/thread/private?token=secret",
        $heatmap_data: {
          "https://example.test/thread/private?token=secret": [
            {
              x: 0.25,
              y: 0.75,
              type: "click",
              text: "CANARY_PROMPT",
              value: "CANARY_PASSWORD",
              selector: "configured-secret",
              href: "https://user:password@example.test/private",
            },
          ],
        },
      },
    });
    await Promise.resolve();

    expect(directDelivery).toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(enqueue.mock.calls[0]);
    expect(serialized).not.toContain("CANARY_PROMPT");
    expect(serialized).not.toContain("CANARY_PASSWORD");
    expect(serialized).not.toContain("configured-secret");
    expect(serialized).not.toContain("thread/private");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("user:password");
    expect(serialized).not.toContain("$current_url");
    expect(serialized).toContain("session-safe");
    expect(serialized).toContain("window-safe");
  });
});
