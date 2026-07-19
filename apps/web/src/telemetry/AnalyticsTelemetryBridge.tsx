import { useEffect, useRef } from "react";
import {
  baseExecutionProfile,
  resolveStudyBuddyProfileForModelSelection,
} from "@t3tools/shared/studyBuddyProfiles";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { useStore } from "../store";
import { buildThreadAnalyticsEvents } from "./analyticsEvents";
import { telemetry } from "./runtime";

export function AnalyticsTelemetryBridge() {
  const hydrated = useClientSettingsHydrated();
  const settings = useSettings();
  const environmentStates = useStore((state) => state.environmentStateById);
  const seen = useRef(new Set<string>());
  const executionProfileByTurn = useRef(
    new Map<string, typeof settings.studyBuddyExecutionProfile>(),
  );

  useEffect(() => {
    if (!hydrated || settings.analyticsConsent !== "accepted" || !settings.analyticsEnabledAt) {
      return;
    }
    const enabledAt = Date.parse(settings.analyticsEnabledAt);
    for (const [environmentId, environment] of Object.entries(environmentStates)) {
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
        const turnKey = `${environmentId}:${threadId}:${turn.turnId}`;
        const executionProfile =
          executionProfileByTurn.current.get(turnKey) ??
          baseExecutionProfile(
            resolveStudyBuddyProfileForModelSelection(settings, thread.modelSelection),
          );
        executionProfileByTurn.current.set(turnKey, executionProfile);
        const activities = (environment.activityIdsByThreadId[threadId] ?? []).flatMap(
          (activityId) => {
            const activity = environment.activityByThreadId[threadId]?.[activityId];
            return activity ? [activity] : [];
          },
        );
        const session = environment.threadSessionById[threadId];
        for (const event of buildThreadAnalyticsEvents({
          threadId,
          modelSelection: thread.modelSelection,
          ...(session?.provider ? { provider: session.provider } : {}),
          executionProfile,
          turn,
          activities,
        })) {
          const eventKey = event.idempotencyKey;
          if (!eventKey || seen.current.has(eventKey)) continue;
          seen.current.add(eventKey);
          void telemetry.capture(event).then((captured) => {
            if (!captured) seen.current.delete(eventKey);
          });
        }
      }
    }
  }, [
    environmentStates,
    hydrated,
    settings.analyticsConsent,
    settings.analyticsEnabledAt,
    settings.studyBuddyCustomExecutionProfiles,
    settings.studyBuddyExecutionProfile,
    settings.studyBuddyExecutionProfileId,
  ]);

  return null;
}
