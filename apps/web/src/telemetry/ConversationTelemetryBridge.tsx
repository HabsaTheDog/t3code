import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, TurnId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { useStore } from "../store";
import { conversationIdempotencyKey } from "./conversation";
import { selectCompletedConversationTurns } from "./conversationSelection";
import { telemetry } from "./runtime";

const MAX_REDACTION_ATTEMPTS = 12;
const MAX_REDACTION_RETRY_MS = 30_000;

interface RedactionRetryState {
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

function redactionRetryDelay(attempt: number): number {
  return Math.min(MAX_REDACTION_RETRY_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export function ConversationTelemetryBridge() {
  const hydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const environmentStates = useStore((state) => state.environmentStateById);
  const attempted = useRef(new Set<string>());
  const retries = useRef(new Map<string, RedactionRetryState>());
  const retryTimers = useRef(new Map<string, number>());
  const [retryTick, setRetryTick] = useState(0);

  useEffect(
    () => () => {
      for (const timer of retryTimers.current.values()) window.clearTimeout(timer);
      retryTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (
      !hydrated ||
      settings.conversationConsent !== "accepted" ||
      !settings.conversationEnabledAt ||
      !settings.installationId
    ) {
      return;
    }

    for (const environmentId of Object.keys(environmentStates) as EnvironmentId[]) {
      const environment = environmentStates[environmentId];
      if (!environment) continue;
      const redactionApi = readEnvironmentApi(environmentId)?.telemetry;
      if (!redactionApi) continue;
      for (const threadId of environment.threadIds) {
        const messageIds = environment.messageIdsByThreadId[threadId] ?? [];
        const messages = messageIds
          .map((id) => environment.messageByThreadId[threadId]?.[id])
          .filter((message) => message !== undefined);
        const latestTurn = environment.threadTurnStateById[threadId]?.latestTurn;
        for (const { turnId } of selectCompletedConversationTurns(messages, latestTurn)) {
          const key = conversationIdempotencyKey(threadId, turnId);
          if (attempted.current.has(key)) continue;
          const retry = retries.current.get(key);
          if (retry && retry.nextAttemptAt > Date.now()) continue;

          attempted.current.add(key);
          void redactionApi
            .redactConversationTurn({ threadId, turnId: turnId as TurnId })
            .then((redacted) =>
              telemetry.exportConversationTurn({
                idempotencyKey: key,
                installationId: settings.installationId,
                threadId,
                turnId,
                aiSessionId: threadId,
                aiTraceId: turnId,
                userText: redacted.userText,
                assistantText: redacted.assistantText,
                provider: redacted.provider,
                model: redacted.model,
                startedAt: redacted.startedAt,
                completedAt: redacted.completedAt,
                latencyMs: redacted.latencyMs,
                state: redacted.state,
                runLogs: redacted.runLogs,
                files: redacted.files,
              }),
            )
            .then(() => {
              retries.current.delete(key);
            })
            .catch(() => {
              const attempts = (retry?.attempts ?? 0) + 1;
              if (attempts >= MAX_REDACTION_ATTEMPTS) {
                retries.current.delete(key);
                void telemetry.capture({
                  event: "feature.failed",
                  idempotencyKey: `feature.failed:conversation.export:${threadId}:${turnId}`,
                  properties: {
                    feature: "conversation.export",
                    feature_area: "Telemetry",
                    feature_label: "Export completed conversation",
                    reason: "redaction_not_ready",
                    attempts,
                  },
                });
                return;
              }
              attempted.current.delete(key);
              const delay = redactionRetryDelay(attempts);
              retries.current.set(key, {
                attempts,
                nextAttemptAt: Date.now() + delay,
              });
              if (!retryTimers.current.has(key)) {
                const timer = window.setTimeout(() => {
                  retryTimers.current.delete(key);
                  setRetryTick((value) => value + 1);
                }, delay);
                retryTimers.current.set(key, timer);
              }
            });
        }
      }
    }
  }, [
    environmentStates,
    hydrated,
    settings.conversationConsent,
    settings.conversationEnabledAt,
    settings.installationId,
    retryTick,
  ]);

  return null;
}
