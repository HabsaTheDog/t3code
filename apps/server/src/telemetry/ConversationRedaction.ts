import type {
  ConversationTurnRedactionResult,
  OrchestrationEvent,
  OrchestrationThread,
  ServerSettings,
  TurnId,
} from "@t3tools/contracts";

import type { StoredStudyBuddyConfiguration } from "../custom-skills/moodle/studyBuddyConfig.ts";

const STUDY_SECRET_KEY = /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY)$/i;

export function redactConversationTurn(input: {
  readonly thread: OrchestrationThread;
  readonly turnId: TurnId;
  readonly studyConfiguration: StoredStudyBuddyConfiguration;
  readonly serverSettings: ServerSettings;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}): ConversationTurnRedactionResult | null {
  if (
    input.thread.latestTurn?.turnId === input.turnId &&
    input.thread.latestTurn.state === "running"
  ) {
    return null;
  }

  let assistantIndex = -1;
  for (let index = 0; index < input.thread.messages.length; index += 1) {
    const message = input.thread.messages[index];
    if (
      message?.role === "assistant" &&
      message.turnId === input.turnId &&
      !message.streaming &&
      message.text.trim()
    ) {
      assistantIndex = index;
    }
  }
  if (assistantIndex < 0) return null;

  const assistant = input.thread.messages[assistantIndex];
  if (!assistant) return null;
  let user = null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = input.thread.messages[index];
    if (candidate?.role === "user") {
      user = candidate;
      break;
    }
  }
  if (!user) return null;

  const turnStart = input.events.find(
    (
      event,
    ): event is Extract<OrchestrationEvent, { readonly type: "thread.turn-start-requested" }> =>
      event.type === "thread.turn-start-requested" &&
      event.aggregateId === input.thread.id &&
      event.payload.messageId === user.id,
  );
  const sessionStart = input.events.find(
    (event): event is Extract<OrchestrationEvent, { readonly type: "thread.session-set" }> =>
      event.type === "thread.session-set" &&
      event.aggregateId === input.thread.id &&
      event.payload.session.activeTurnId === input.turnId &&
      event.payload.session.status === "running",
  );
  const checkpoint = input.thread.checkpoints.find(
    (candidate) => candidate.turnId === input.turnId,
  );
  const latest =
    input.thread.latestTurn?.turnId === input.turnId && input.thread.latestTurn.state !== "running"
      ? input.thread.latestTurn
      : null;
  const startedAt =
    sessionStart?.payload.session.updatedAt ??
    latest?.startedAt ??
    turnStart?.payload.createdAt ??
    user.createdAt;
  const completedAt = checkpoint?.completedAt ?? latest?.completedAt ?? null;
  const modelSelection = turnStart?.payload.modelSelection ?? input.thread.modelSelection;
  const providerInstanceId =
    sessionStart?.payload.session.providerInstanceId ?? modelSelection.instanceId;
  const provider =
    sessionStart?.payload.session.providerName ??
    input.serverSettings.providerInstances[providerInstanceId]?.driver ??
    (["codex", "claude", "claudeAgent", "cursor", "opencode"].includes(providerInstanceId)
      ? providerInstanceId
      : null);
  if (!completedAt || !provider) return null;
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return null;
  const checkpointState =
    checkpoint?.status === "error"
      ? "error"
      : checkpoint?.status === "missing"
        ? "interrupted"
        : checkpoint?.status === "ready"
          ? "success"
          : null;
  const state =
    checkpointState ??
    (latest?.state === "error"
      ? "error"
      : latest?.state === "interrupted"
        ? "interrupted"
        : latest?.state === "completed"
          ? "success"
          : null);
  if (!state) return null;

  const secrets = collectConfiguredSecrets(input.studyConfiguration, input.serverSettings);
  const runLogs = input.thread.activities
    .filter((activity) => activity.turnId === input.turnId)
    .map((activity) => ({
      kind: activity.kind,
      tone: activity.tone,
      summary: redactExactSecrets(activity.summary, secrets),
      createdAt: activity.createdAt,
    }));
  const files = (checkpoint?.files ?? []).map((file) => {
    const normalizedPath = file.path.replaceAll("\\", "/");
    const relativePath = normalizedPath.startsWith("/")
      ? (normalizedPath.split("/").findLast((segment) => segment.length > 0) ?? "generated-file")
      : normalizedPath.replace(/^(?:\.\.\/)+/u, "");
    return {
      name: relativePath.split("/").at(-1) ?? relativePath,
      relativePath,
      ...(file.kind ? { kind: file.kind } : {}),
      ...(file.additions === undefined ? {} : { additions: file.additions }),
      ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
    };
  });
  return {
    userText: redactExactSecrets(user.text, secrets),
    assistantText: redactExactSecrets(assistant.text, secrets),
    provider,
    model: modelSelection.model,
    startedAt,
    completedAt,
    latencyMs: Math.max(0, completedMs - startedMs),
    state,
    runLogs,
    files,
  };
}

export function collectConfiguredSecrets(
  studyConfiguration: StoredStudyBuddyConfiguration,
  serverSettings: ServerSettings,
): ReadonlyArray<string> {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(studyConfiguration.values)) {
    if (STUDY_SECRET_KEY.test(key) && value.trim().length >= 4) {
      secrets.add(value);
    }
  }
  for (const instance of Object.values(serverSettings.providerInstances)) {
    for (const variable of instance.environment ?? []) {
      if (variable.sensitive && variable.value.trim().length >= 4) {
        secrets.add(variable.value);
      }
    }
  }
  return [...secrets];
}

function redactExactSecrets(value: string, secrets: ReadonlyArray<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED_CONFIGURED_SECRET]");
  }
  return redacted;
}
