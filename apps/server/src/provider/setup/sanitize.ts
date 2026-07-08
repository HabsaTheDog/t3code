/* eslint-disable no-control-regex -- terminal sanitization intentionally strips control bytes */
const ANSI_ESCAPE = /\u001b(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;
const BEARER_TOKEN = /\bbearer\s+[a-z0-9._~+/-]+=*/gi;
const COMMON_SECRET = /\b(sk|sess|key)-[a-z0-9_-]{8,}\b/gi;
const NAMED_SECRET =
  /\b(api[ _-]?key|password|passwd|token|cookie|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CREDENTIAL_URL = /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const SENSITIVE_QUERY_PARAMETER =
  /([?&](?:access_token|api_key|apikey|auth|code|key|password|token)=)[^&#\s]+/gi;

const MAX_PROGRESS_LINE_LENGTH = 4_096;
const MAX_BUFFERED_LINE_LENGTH = 16_384;

export function sanitizeProviderSetupOutput(
  value: string,
  sensitiveValues: ReadonlyArray<string> = [],
): string {
  let sanitized = value.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, "");

  for (const sensitiveValue of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (sensitiveValue.length > 0) {
      sanitized = sanitized.split(sensitiveValue).join("[REDACTED]");
    }
  }

  return sanitized
    .replace(CREDENTIAL_URL, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY_PARAMETER, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(COMMON_SECRET, "[REDACTED]")
    .replace(NAMED_SECRET, "$1=[REDACTED]")
    .slice(0, MAX_PROGRESS_LINE_LENGTH);
}

export interface ProviderSetupProgressSanitizer {
  readonly write: (chunk: Uint8Array | string) => void;
  readonly end: () => void;
}

export function makeProviderSetupProgressSanitizer(input: {
  readonly sensitiveValues?: ReadonlyArray<string> | undefined;
  readonly emit: (line: string) => void;
}): ProviderSetupProgressSanitizer {
  const decoder = new TextDecoder();
  let buffer = "";
  let suppressingOversizedLine = false;

  const emitSanitized = (line: string) => {
    const sanitized = sanitizeProviderSetupOutput(line.replace(/\r$/, ""), input.sensitiveValues);
    if (sanitized.length > 0) {
      input.emit(sanitized);
    }
  };

  const consume = () => {
    for (;;) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        if (buffer.length > MAX_BUFFERED_LINE_LENGTH) {
          if (!suppressingOversizedLine) {
            input.emit("[oversized output line suppressed]");
            suppressingOversizedLine = true;
          }
          buffer = "";
        }
        return;
      }

      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (suppressingOversizedLine) {
        suppressingOversizedLine = false;
      } else {
        emitSanitized(line);
      }
    }
  };

  return {
    write: (chunk) => {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      consume();
    },
    end: () => {
      buffer += decoder.decode();
      consume();
      if (!suppressingOversizedLine && buffer.length > 0) {
        emitSanitized(buffer);
      }
      buffer = "";
    },
  };
}
