import { useEffect, useRef } from "react";
import type { EnvironmentId, TurnId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { useStore } from "../store";
import { conversationIdempotencyKey } from "./conversation";
import { selectCompletedConversationTurns } from "./conversationSelection";
import { telemetry } from "./runtime";

export function ConversationTelemetryBridge() {
  const hydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const environmentStates = useStore((state) => state.environmentStateById);
  const attempted = useRef(new Set<string>());

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
              }),
            )
            .then((exported) => {
              if (!exported) attempted.current.delete(key);
            })
            .catch(() => {
              attempted.current.delete(key);
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
  ]);

  return null;
}
