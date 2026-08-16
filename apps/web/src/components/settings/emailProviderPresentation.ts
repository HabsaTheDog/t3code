import type { StudyBuddyEmailProviderHint } from "@t3tools/contracts";

export const EMAIL_PROVIDER_OPTIONS: ReadonlyArray<{
  value: StudyBuddyEmailProviderHint;
  label: string;
  description: string;
  presetUrl?: string;
}> = [
  {
    value: "auto-detect",
    label: "Choose automatically",
    description: "Enter your university email website and Study Buddy will recognize the service.",
  },
  { value: "sogo", label: "SOGo", description: "Choose this if your university uses SOGo." },
  {
    value: "roundcube",
    label: "Roundcube",
    description: "Choose this if your university uses Roundcube.",
  },
  {
    value: "microsoft-365",
    label: "Microsoft 365 / Outlook",
    description: "University email hosted by Microsoft.",
    presetUrl: "imaps://outlook.office365.com:993",
  },
  {
    value: "google-workspace",
    label: "Google Workspace / Gmail",
    description: "University email hosted by Google.",
    presetUrl: "imaps://imap.gmail.com:993",
  },
  {
    value: "standard-imaps",
    label: "Other email server (IMAP)",
    description: "Use the server address supplied by your university.",
  },
  {
    value: "other-webmail",
    label: "Another email website",
    description: "Use this when your university email website is not listed.",
  },
];

export type EmailDiscovery =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "recognized"; label: string; detail: string }
  | { status: "manual"; detail: string };

export function emailProviderOption(hint: StudyBuddyEmailProviderHint) {
  return EMAIL_PROVIDER_OPTIONS.find((option) => option.value === hint)!;
}

export function recognizeEmailProvider(
  hint: StudyBuddyEmailProviderHint,
  rawUrl: string,
): EmailDiscovery {
  const value = rawUrl.trim();
  if (!value) return { status: "idle" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { status: "manual", detail: "Enter the full website or server address." };
  }
  if (parsed.protocol === "imaps:") {
    const label =
      hint === "microsoft-365"
        ? "Microsoft 365 / Outlook"
        : hint === "google-workspace"
          ? "Google Workspace / Gmail"
          : "Other email server (IMAP)";
    return { status: "recognized", label, detail: "Secure email server recognized." };
  }
  if (parsed.protocol !== "https:") {
    return {
      status: "manual",
      detail: "Use a website that starts with https:// or a server that starts with imaps://.",
    };
  }

  const signature = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  if (hint === "sogo" || signature.includes("sogo")) {
    return { status: "recognized", label: "SOGo", detail: "Recognized from the address." };
  }
  if (hint === "roundcube" || signature.includes("roundcube")) {
    return {
      status: "recognized",
      label: "Roundcube",
      detail: "Recognized from the address.",
    };
  }
  if (
    hint === "microsoft-365" ||
    signature.includes("outlook.office") ||
    signature.includes("office.com")
  ) {
    return {
      status: "recognized",
      label: "Microsoft 365 / Outlook",
      detail: "Microsoft email recognized.",
    };
  }
  if (
    hint === "google-workspace" ||
    signature.includes("mail.google") ||
    signature.includes("gmail.com")
  ) {
    return {
      status: "recognized",
      label: "Google Workspace / Gmail",
      detail: "Google email recognized.",
    };
  }
  return {
    status: "manual",
    detail: "Study Buddy will check this address after you save.",
  };
}
