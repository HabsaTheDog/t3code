import { useEffect, useRef } from "react";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { useStore } from "../store";
import { telemetry } from "./runtime";

export function AnalyticsTelemetryBridge() {
  const hydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const environmentStates = useStore((state) => state.environmentStateById);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!hydrated || settings.analyticsConsent !== "accepted" || !settings.analyticsEnabledAt) {
      return;
    }
    const enabledAt = Date.parse(settings.analyticsEnabledAt);
    for (const environment of Object.values(environmentStates)) {
      for (const threadId of environment.threadIds) {
        const thread = environment.threadShellById[threadId];
        if (!thread) continue;
        const threadKey = `thread.created:${threadId}`;
        if (Date.parse(thread.createdAt) >= enabledAt && !seen.current.has(threadKey)) {
          seen.current.add(threadKey);
          void telemetry
            .capture({
              event: "thread.created",
              idempotencyKey: threadKey,
              timestamp: thread.createdAt,
            })
            .then((captured) => {
              if (!captured) seen.current.delete(threadKey);
            });
        }

        const turn = environment.threadTurnStateById[threadId]?.latestTurn;
        if (!turn || Date.parse(turn.requestedAt) < enabledAt) continue;
        const stateEvent =
          turn.state === "running"
            ? "turn.started"
            : turn.state === "completed"
              ? "turn.completed"
              : turn.state === "interrupted"
                ? "turn.interrupted"
                : "turn.failed";
        const turnKey = `${stateEvent}:${threadId}:${turn.turnId}`;
        if (seen.current.has(turnKey)) continue;
        seen.current.add(turnKey);
        void telemetry
          .capture({
            event: stateEvent,
            idempotencyKey: turnKey,
            timestamp:
              stateEvent === "turn.started"
                ? (turn.startedAt ?? turn.requestedAt)
                : (turn.completedAt ?? turn.requestedAt),
          })
          .then((captured) => {
            if (!captured) seen.current.delete(turnKey);
          });
      }
    }
  }, [environmentStates, hydrated, settings.analyticsConsent, settings.analyticsEnabledAt]);

  return null;
}
