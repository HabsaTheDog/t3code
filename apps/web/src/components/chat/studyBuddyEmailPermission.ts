import type { StudyBuddyEmailSendApprovalPayload, UserInputQuestion } from "@t3tools/contracts";

export const STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID = "study_buddy_email_send_v1";
const EMAIL_ADDRESS_PATTERN = /^[^\s<>@\r\n]+@[^\s<>@\r\n]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function parseStudyBuddyEmailPermissionQuestion(
  question: UserInputQuestion | null | undefined,
): StudyBuddyEmailSendApprovalPayload | null {
  if (!question || question.id !== STUDY_BUDDY_EMAIL_PERMISSION_QUESTION_ID) return null;
  let value: unknown;
  try {
    value = JSON.parse(question.question);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const from = normalizeAddress(value.from);
  const to = normalizeAddressArray(value.to);
  const cc = normalizeAddressArray(value.cc);
  const bcc = normalizeAddressArray(value.bcc);
  if (
    value.version !== 1 ||
    value.owner !== "study-buddy" ||
    value.action !== "send_email" ||
    typeof value.sourceId !== "string" ||
    value.sourceId.trim().length === 0 ||
    typeof value.subject !== "string" ||
    value.subject.length > 2_000 ||
    /[\r\n]/.test(value.subject) ||
    typeof value.bodyText !== "string" ||
    value.bodyText.length > 100_000 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !from ||
    !isAddressArray(to, true) ||
    !isAddressArray(cc) ||
    !isAddressArray(bcc) ||
    !Array.isArray(value.attachments)
  ) {
    return null;
  }
  const attachments = value.attachments.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      typeof item.name !== "string" ||
      item.name.length > 2_000 ||
      /[\r\n]/.test(item.name) ||
      typeof item.sizeBytes !== "number" ||
      !Number.isInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      item.sizeBytes > 25 * 1024 * 1024 ||
      typeof item.sha256 !== "string" ||
      !SHA256_PATTERN.test(item.sha256)
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      },
    ];
  });
  if (attachments.length !== value.attachments.length || attachments.length > 20) return null;
  return {
    version: 1,
    owner: "study-buddy",
    action: "send_email",
    sourceId: value.sourceId,
    from,
    to,
    cc,
    bcc,
    subject: value.subject,
    bodyText: value.bodyText,
    attachments,
    expiresAt: value.expiresAt,
  };
}

function normalizeAddress(value: unknown): { name?: string; address: string } | null {
  const candidate = typeof value === "string" ? { address: value } : value;
  return isAddress(candidate) ? candidate : null;
}

function normalizeAddressArray(value: unknown): Array<{ name?: string; address: string }> | null {
  if (!Array.isArray(value)) return null;
  const addresses = value.map(normalizeAddress);
  return addresses.every((address) => address !== null)
    ? (addresses as Array<{ name?: string; address: string }>)
    : null;
}

export function emailPermissionOptionCopy(label: string, description: string) {
  const normalized = label.trim().toLowerCase();
  if (normalized.startsWith("send this email")) {
    return {
      label: "Send this email",
      description: "Send this exact message once.",
      intent: "approve" as const,
    };
  }
  if (normalized === "do not send" || normalized === "decline") {
    return {
      label: "Do not send",
      description: "Nothing will be sent.",
      intent: "decline" as const,
    };
  }
  return { label, description, intent: "neutral" as const };
}

export function formatEmailAddress(address: { name?: string; address: string }): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function isAddress(value: unknown): value is { name?: string; address: string } {
  return (
    isRecord(value) &&
    typeof value.address === "string" &&
    value.address.length <= 320 &&
    EMAIL_ADDRESS_PATTERN.test(value.address) &&
    (value.name === undefined ||
      (typeof value.name === "string" && value.name.length <= 2_000 && !/[\r\n]/.test(value.name)))
  );
}

function isAddressArray(
  value: unknown,
  required = false,
): value is Array<{
  name?: string;
  address: string;
}> {
  return (
    Array.isArray(value) &&
    (!required || value.length > 0) &&
    value.length <= 100 &&
    value.every(isAddress)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
