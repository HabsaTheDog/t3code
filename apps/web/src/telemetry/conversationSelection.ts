export interface ConversationSelectionMessage {
  readonly role: string;
  readonly text: string;
  readonly turnId?: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

export interface ConversationSelectionTurn {
  readonly turnId: string;
  readonly state: "running" | "completed" | "interrupted" | "error";
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

export interface SelectedConversationTurn {
  readonly turnId: string;
  readonly user: ConversationSelectionMessage;
  readonly assistant: ConversationSelectionMessage;
  readonly terminal: ConversationSelectionTurn | null;
}

/**
 * Selects exactly one final assistant message per terminal turn. Historical
 * turns are terminal by definition once a newer latest turn exists.
 */
export function selectCompletedConversationTurns(
  messages: ReadonlyArray<ConversationSelectionMessage>,
  latestTurn: ConversationSelectionTurn | null | undefined,
): ReadonlyArray<SelectedConversationTurn> {
  const finalAssistantByTurn = new Map<
    string,
    { readonly assistant: ConversationSelectionMessage; readonly index: number }
  >();
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (
      assistant?.role === "assistant" &&
      assistant.turnId &&
      !assistant.streaming &&
      assistant.text.trim().length > 0
    ) {
      finalAssistantByTurn.set(assistant.turnId, { assistant, index });
    }
  }

  const selected: SelectedConversationTurn[] = [];
  for (const [turnId, candidate] of finalAssistantByTurn) {
    if (latestTurn?.turnId === turnId && latestTurn.state === "running") continue;

    let user: ConversationSelectionMessage | null = null;
    for (let index = candidate.index - 1; index >= 0; index -= 1) {
      const possibleUser = messages[index];
      if (possibleUser?.role === "user") {
        user = possibleUser;
        break;
      }
    }
    if (!user) continue;

    selected.push({
      turnId,
      user,
      assistant: candidate.assistant,
      terminal:
        latestTurn && latestTurn.turnId === turnId && latestTurn.state !== "running"
          ? latestTurn
          : null,
    });
  }
  return selected;
}
