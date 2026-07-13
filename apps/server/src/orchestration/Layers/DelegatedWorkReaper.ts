import {
  CommandId,
  EventId,
  type OrchestrationDelegatedWork,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { increment, orchestrationDelegatedWorkTimeoutTotal } from "../../observability/Metrics.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  DelegatedWorkReaper,
  type DelegatedWorkReaperShape,
} from "../Services/DelegatedWorkReaper.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_STALE_PROGRESS_MS = 10 * 60 * 1000;

const activeStatuses = new Set<OrchestrationDelegatedWork["status"]>([
  "created",
  "running",
  "progress",
]);

export interface DelegatedWorkReaperLiveOptions {
  readonly timeoutMs?: number;
  readonly sweepIntervalMs?: number;
  readonly staleProgressMs?: number;
}

function envInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasActiveRequiredWork(thread: OrchestrationThread): boolean {
  return thread.delegatedWork.some(
    (entry) =>
      entry.required && entry.blockingPolicy === "required" && activeStatuses.has(entry.status),
  );
}

function hasPendingRequiredReview(thread: OrchestrationThread): boolean {
  return thread.delegatedWork.some(
    (entry) =>
      entry.required && entry.blockingPolicy === "required" && entry.reviewStatus === "pending",
  );
}

const makeDelegatedWorkReaper = (options?: DelegatedWorkReaperLiveOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const timeoutMs = Math.max(
      1,
      options?.timeoutMs ?? envInt("T3_DELEGATED_WORK_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
    );
    const sweepIntervalMs = Math.max(
      1,
      options?.sweepIntervalMs ??
        envInt("T3_DELEGATED_WORK_REAPER_INTERVAL_MS") ??
        DEFAULT_SWEEP_INTERVAL_MS,
    );
    const staleProgressMs = Math.max(
      1,
      options?.staleProgressMs ??
        envInt("T3_DELEGATED_WORK_STALE_PROGRESS_MS") ??
        DEFAULT_STALE_PROGRESS_MS,
    );

    const commandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const eventId = (tag: string, id: string) => EventId.make(`delegated-work:${tag}:${id}`);

    const sweep = Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      let timedOutCount = 0;

      for (const thread of snapshot.threads) {
        const nextDelegatedWork = [...thread.delegatedWork];
        for (const [workIndex, work] of thread.delegatedWork.entries()) {
          if (!activeStatuses.has(work.status)) {
            continue;
          }
          const lastActivityMs = Date.parse(work.lastProgressAt ?? work.updatedAt);
          if (Number.isNaN(lastActivityMs)) {
            continue;
          }
          const staleForMs = nowMs - lastActivityMs;
          const absoluteAgeMs = nowMs - Date.parse(work.createdAt);
          if (staleForMs < staleProgressMs && absoluteAgeMs < timeoutMs) {
            continue;
          }
          const timedOut: OrchestrationDelegatedWork = {
            ...work,
            status: "timed_out",
            error: `Delegated work timed out after ${Math.round(staleForMs / 1000)}s without fresh progress.`,
            completedAt: nowIso,
            timedOutAt: nowIso,
            updatedAt: nowIso,
            reviewStatus:
              work.required && work.blockingPolicy === "required" ? "pending" : "not_required",
          };
          yield* orchestrationEngine.dispatch({
            type: "thread.delegated-work.upsert",
            commandId: yield* commandId("delegated-work-timeout"),
            threadId: thread.id,
            delegatedWork: timedOut,
            createdAt: nowIso,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* commandId("delegated-work-timeout-activity"),
            threadId: thread.id,
            activity: {
              id: eventId("timeout", `${thread.id}:${work.id}:${nowMs}`),
              tone: "error",
              kind: "delegated-work.timed-out",
              summary: "Delegated work timed out",
              payload: {
                id: work.id,
                task: work.task,
                staleForMs,
              },
              turnId: work.parentTurnId,
              createdAt: nowIso,
            },
            createdAt: nowIso,
          });
          yield* increment(orchestrationDelegatedWorkTimeoutTotal, {
            required: String(work.required),
            blockingPolicy: work.blockingPolicy,
          });
          timedOutCount += 1;
          nextDelegatedWork[workIndex] = timedOut;
        }

        const nextThread = { ...thread, delegatedWork: nextDelegatedWork };

        if (!hasActiveRequiredWork(nextThread) && hasPendingRequiredReview(nextThread)) {
          for (const deferred of nextThread.deferredFinalizations ?? []) {
            if (deferred.state !== "waiting") {
              continue;
            }
            yield* orchestrationEngine.dispatch({
              type: "thread.delegated-work-review.request",
              commandId: yield* commandId("delegated-work-review-request"),
              threadId: nextThread.id,
              turnId: deferred.turnId,
              createdAt: nowIso,
            });
          }
        }
      }

      if (timedOutCount > 0) {
        yield* Effect.logInfo("delegated-work.reaper.sweep-complete", { timedOutCount });
      }
    });

    const start: DelegatedWorkReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("delegated-work.reaper.sweep-failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("delegated-work.reaper.started", {
          timeoutMs,
          staleProgressMs,
          sweepIntervalMs,
        });
      });

    return { start } satisfies DelegatedWorkReaperShape;
  });

export const makeDelegatedWorkReaperLive = (options?: DelegatedWorkReaperLiveOptions) =>
  Layer.effect(DelegatedWorkReaper, makeDelegatedWorkReaper(options));

export const DelegatedWorkReaperLive = makeDelegatedWorkReaperLive();
