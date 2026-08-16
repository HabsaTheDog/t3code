import type {
  StudyBuddySourceBlock,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
} from "@t3tools/contracts";

export interface StudyBuddyEmailPermissionState {
  readonly read: boolean;
  readonly draft: boolean;
  readonly send: boolean;
  readonly senderEmail: string;
  readonly sendingSupported: boolean;
}

export function emailPermissionState(
  source: StudyBuddySourceBlock,
  connection: StudyBuddySourceConnection | undefined,
): StudyBuddyEmailPermissionState {
  return {
    read:
      source.policy.authenticatedReads === "allowed" &&
      source.capabilities.includes("mail.message.read"),
    draft:
      source.policy.remoteDrafts === "allowed" && source.capabilities.includes("mail.draft.local"),
    send:
      source.policy.emailSend === "approval-required" && source.capabilities.includes("mail.send"),
    senderEmail: connection?.auth.emailAddress ?? suggestedSenderEmail(connection),
    sendingSupported: connection?.adapterId === "sogo" || connection?.adapterId === "roundcube",
  };
}

export function isEmailAddress(value: string): boolean {
  return /^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/.test(value.trim());
}

export function optimisticEmailPermissionInventory(
  inventory: StudyBuddySourceInventory,
  sourceId: string,
  permissions: Pick<StudyBuddyEmailPermissionState, "read" | "draft" | "send" | "senderEmail">,
): StudyBuddySourceInventory {
  const source = inventory.sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.kind !== "email") return inventory;

  const unrelatedCapabilities = source.capabilities.filter(
    (capability) => !capability.startsWith("mail."),
  );
  return {
    ...inventory,
    sources: inventory.sources.map((candidate) =>
      candidate.id === sourceId
        ? {
            ...candidate,
            capabilities: [
              ...unrelatedCapabilities,
              ...(permissions.read ? (["mail.threads.list", "mail.message.read"] as const) : []),
              ...(permissions.draft ? (["mail.draft.local"] as const) : []),
              ...(permissions.send ? (["mail.send"] as const) : []),
            ],
            policy: {
              ...candidate.policy,
              authenticatedReads: permissions.read ? "allowed" : "denied",
              remoteDrafts: permissions.draft ? "allowed" : "denied",
              emailSend: permissions.send ? "approval-required" : "denied",
            },
          }
        : candidate,
    ),
    connections: inventory.connections.map((connection) => {
      if (connection.id !== source.connectionId) return connection;
      const { emailAddress: _previousEmailAddress, ...authWithoutEmailAddress } = connection.auth;
      return {
        ...connection,
        auth: permissions.senderEmail
          ? { ...connection.auth, emailAddress: permissions.senderEmail }
          : authWithoutEmailAddress,
      };
    }),
  };
}

function suggestedSenderEmail(connection: StudyBuddySourceConnection | undefined): string {
  const accountLabel = connection?.auth.accountLabel?.trim() ?? "";
  return isEmailAddress(accountLabel) ? accountLabel : "";
}
