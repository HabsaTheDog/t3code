import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  StudyBuddyExecutionProfile,
  ThreadId,
} from "@t3tools/contracts";

import type { SemanticTelemetryEvent } from "./types";

type TaskStatus = "completed" | "failed" | "stopped";

interface TaskActivity {
  readonly taskId: string;
  readonly taskType?: string;
  readonly status?: TaskStatus;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

interface TaskInterval {
  readonly taskId: string;
  readonly taskType: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly status: TaskStatus;
  readonly usage?: Readonly<Record<string, unknown>>;
}

const SAFE_TASK_TYPES = new Set([
  "codex-collab",
  "document",
  "formatter",
  "moodle",
  "plan",
  "scraping",
  "study-buddy",
  "summarization",
  "summary",
  "tool",
  "visual",
  "website",
]);

const SAFE_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface ThreadAnalyticsInput {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly provider?: ProviderDriverKind;
  readonly executionProfile: StudyBuddyExecutionProfile;
  readonly turn: OrchestrationLatestTurn | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readTaskActivity(activity: OrchestrationThreadActivity): TaskActivity | undefined {
  if (activity.kind !== "task.started" && activity.kind !== "task.completed") return undefined;
  const payload = asRecord(activity.payload);
  if (!payload) return undefined;
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) return undefined;
  const taskType = typeof payload.taskType === "string" ? payload.taskType.trim() : undefined;
  const rawStatus = payload.status;
  const status =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "stopped"
      ? rawStatus
      : undefined;
  const usage = asRecord(payload.usage);
  return {
    taskId,
    ...(taskType ? { taskType } : {}),
    ...(status ? { status } : {}),
    ...(usage ? { usage } : {}),
    createdAt: activity.createdAt,
  };
}

function numberFrom(record: Readonly<Record<string, unknown>> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function usageProperties(usages: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>) {
  interface UsageTotals {
    tokens_in: number;
    tokens_cached: number;
    tokens_out: number;
    tokens_reasoning: number;
  }
  const totals = usages.reduce<UsageTotals>(
    (total, usage) => ({
      tokens_in:
        total.tokens_in + numberFrom(usage, "inputTokens", "lastInputTokens", "input_tokens"),
      tokens_cached:
        total.tokens_cached +
        numberFrom(usage, "cachedInputTokens", "lastCachedInputTokens", "cached_input_tokens"),
      tokens_out:
        total.tokens_out + numberFrom(usage, "outputTokens", "lastOutputTokens", "output_tokens"),
      tokens_reasoning:
        total.tokens_reasoning +
        numberFrom(
          usage,
          "reasoningOutputTokens",
          "lastReasoningOutputTokens",
          "reasoning_output_tokens",
        ),
    }),
    { tokens_in: 0, tokens_cached: 0, tokens_out: 0, tokens_reasoning: 0 },
  );
  return Object.fromEntries(
    (Object.entries(totals) as Array<[keyof UsageTotals, number]>).filter(([, value]) => value > 0),
  );
}

function reasoningEffort(modelSelection: ModelSelection): string | undefined {
  const option = modelSelection.options?.find(
    ({ id }) => id === "reasoningEffort" || id === "reasoning_effort" || id === "effort",
  );
  if (typeof option?.value !== "string") return undefined;
  const normalized = option.value.trim().toLowerCase();
  return SAFE_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function safeTaskType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return SAFE_TASK_TYPES.has(normalized) ? normalized : "unknown";
}

function modelProperties(input: ThreadAnalyticsInput) {
  const effort = reasoningEffort(input.modelSelection);
  return {
    model: input.modelSelection.model,
    execution_profile: input.executionProfile,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  };
}

function taskIntervals(input: ThreadAnalyticsInput): ReadonlyArray<TaskInterval> {
  const turnId = input.turn?.turnId;
  if (!turnId) return [];
  const starts = new Map<string, { startedAt: number; taskType: string }>();
  const completions = new Map<string, TaskInterval>();
  const sorted = input.activities
    .filter((activity) => String(activity.turnId) === String(turnId))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const activity of sorted) {
    const task = readTaskActivity(activity);
    if (!task) continue;
    const at = Date.parse(task.createdAt);
    if (!Number.isFinite(at)) continue;
    if (activity.kind === "task.started") {
      if (!starts.has(task.taskId)) {
        starts.set(task.taskId, { startedAt: at, taskType: task.taskType ?? "unknown" });
      }
      continue;
    }
    if (!task.status || completions.has(task.taskId)) continue;
    const start = starts.get(task.taskId);
    completions.set(task.taskId, {
      taskId: task.taskId,
      taskType: start?.taskType ?? task.taskType ?? "unknown",
      startedAt: start?.startedAt ?? at,
      completedAt: at,
      status: task.status,
      ...(task.usage ? { usage: task.usage } : {}),
    });
  }
  return [...completions.values()];
}

function peakParallelism(intervals: ReadonlyArray<TaskInterval>): number {
  const edges = intervals.flatMap((interval) => [
    { at: interval.startedAt, delta: 1 },
    { at: Math.max(interval.startedAt, interval.completedAt), delta: -1 },
  ]);
  edges.sort((left, right) => left.at - right.at || right.delta - left.delta);
  let active = 0;
  let peak = 0;
  for (const edge of edges) {
    active += edge.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function buildThreadAnalyticsEvents(
  input: ThreadAnalyticsInput,
): ReadonlyArray<SemanticTelemetryEvent> {
  const turn = input.turn;
  if (!turn) return [];
  const intervals = taskIntervals(input);
  const common = modelProperties(input);
  const events: SemanticTelemetryEvent[] = [];

  if (turn.state !== "running") {
    for (const interval of intervals) {
      events.push({
        event: "orchestration.task.completed",
        idempotencyKey: `orchestration.task.completed:${input.threadId}:${turn.turnId}:${interval.taskId}`,
        timestamp: new Date(interval.completedAt).toISOString(),
        properties: {
          ...common,
          task_type: safeTaskType(interval.taskType),
          status: interval.status,
          duration_ms: Math.max(0, interval.completedAt - interval.startedAt),
          ...usageProperties([interval.usage]),
        },
      });
    }
  }

  const stateEvent =
    turn.state === "running"
      ? "turn.started"
      : turn.state === "completed"
        ? "turn.completed"
        : turn.state === "interrupted"
          ? "turn.interrupted"
          : "turn.failed";
  const startedAt = Date.parse(turn.startedAt ?? turn.requestedAt);
  const terminalAt = Date.parse(turn.completedAt ?? turn.requestedAt);
  events.push({
    event: stateEvent,
    idempotencyKey: `${stateEvent}:${input.threadId}:${turn.turnId}`,
    timestamp:
      stateEvent === "turn.started"
        ? (turn.startedAt ?? turn.requestedAt)
        : (turn.completedAt ?? turn.requestedAt),
    properties: {
      ...common,
      ...(stateEvent !== "turn.started" && Number.isFinite(startedAt) && Number.isFinite(terminalAt)
        ? { duration_ms: Math.max(0, terminalAt - startedAt) }
        : {}),
      task_count: intervals.length,
      max_parallel_tasks: peakParallelism(intervals),
      ...usageProperties(intervals.map(({ usage }) => usage)),
    },
  });
  return events;
}
