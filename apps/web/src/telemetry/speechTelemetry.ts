export type SpeechFailureStage = "microphone" | "audio_processing" | "transcription";

export type SpeechFailureKind =
  | "permission_denied"
  | "device_unavailable"
  | "model_unavailable"
  | "no_speech"
  | "processing_failed"
  | "unknown";

export type SpeechModelFailureKind =
  | "download_failed"
  | "integrity_failed"
  | "extraction_failed"
  | "files_missing"
  | "unknown";

/** Reduces browser/native errors to bounded categories and never returns the original message. */
export function classifySpeechFailure(error: unknown): SpeechFailureKind {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "notallowederror" || name === "securityerror" || message.includes("permission")) {
    return "permission_denied";
  }
  if (
    name === "notfounderror" ||
    name === "notreadableerror" ||
    message.includes("microphone") ||
    message.includes("device")
  ) {
    return "device_unavailable";
  }
  if (message.includes("not ready") || message.includes("model")) return "model_unavailable";
  if (message.includes("no speech")) return "no_speech";
  if (error instanceof Error) return "processing_failed";
  return "unknown";
}

/** Reduces persisted installer failures to categories safe for ordinary analytics. */
export function classifySpeechModelFailure(
  message: string | null | undefined,
): SpeechModelFailureKind {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("integrity") || normalized.includes("sha")) return "integrity_failed";
  if (normalized.includes("archive") || normalized.includes("extract")) return "extraction_failed";
  if (normalized.includes("missing") || normalized.includes("model files")) return "files_missing";
  if (normalized.includes("download") || normalized.includes("http")) return "download_failed";
  return "unknown";
}

export function safeSpeechDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(3 * 60 * 1_000, Math.round(durationMs));
}
