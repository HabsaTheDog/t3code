const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|bearer|cookie|password|passwd|secret|token|api[_-]?key|credential)(?:$|[_-])/i;
const DISALLOWED_PROPERTY_KEY =
  /(?:url|href|pathname|search|query|filename|file_name|file_path|path|text|prompt|message|content|transcript|terminal|diff|command|input|output|value|innerhtml|outerhtml|attributes?)/i;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:sk|pk|phc)[_-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [
    /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g,
    "[REDACTED_KEY]",
  ],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]"],
  [/\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;&]+/gi, "password=[REDACTED]"],
  [/\b(?:session|auth|access|refresh)[_-]?token\s*[:=]\s*[^\s,;&]+/gi, "token=[REDACTED]"],
  [/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "Cookie: [REDACTED]"],
  [/\b(?:cookie|session(?:id)?)\s*=\s*[^\s,;&]+/gi, "cookie=[REDACTED]"],
  [
    /\b(?:webcal|https?):\/\/[^\s<>"']*?(?:token|key|secret|auth|password)=[^\s&#<>"']+/gi,
    "[REDACTED_URL]",
  ],
  [/\bwebcal:\/\/[^\s<>"']+/gi, "[REDACTED_CALENDAR_URL]"],
  [/\bhttps?:\/\/[^\s<>"']+\.ics(?:[?#][^\s<>"']*)?/gi, "[REDACTED_CALENDAR_URL]"],
];

export function redactSensitiveText(
  value: string,
  configuredSecrets: ReadonlyArray<string> = [],
): string {
  let redacted = value;
  for (const secret of configuredSecrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[REDACTED_CONFIGURED_SECRET]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redactCredentialBearingUrls(redacted)
    .replace(
      /(?:\/(?:home|Users|var|tmp|private|opt|workspace)\/[^\s,;:'"<>]+|[A-Za-z]:\\[^\s,;:'"<>]+)/gu,
      "[REDACTED_PATH]",
    )
    .replace(/```diff[\s\S]*?```/giu, "```diff\n[REDACTED_DIFF]\n```");
}

function redactCredentialBearingUrls(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) {
        return `${url.protocol}//${url.host}/[REDACTED_CREDENTIAL_URL]`;
      }
      return candidate;
    } catch {
      return candidate;
    }
  });
}

export function stripUrl(value: string): string {
  try {
    const url = new URL(value, "https://local.invalid");
    return url.pathname === "/" ? "/" : url.pathname.replace(/[^/]+/g, ":segment");
  } catch {
    return "[REDACTED_URL]";
  }
}

function sanitizeValue(value: unknown, configuredSecrets: ReadonlyArray<string>): unknown {
  if (typeof value === "string") {
    return sanitizeAnalyticsString(value, configuredSecrets).slice(0, 500);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeValue(entry, configuredSecrets));
  }
  if (typeof value !== "object") {
    return undefined;
  }
  return sanitizeRecord(value as Readonly<Record<string, unknown>>, configuredSecrets);
}

function sanitizeAnalyticsString(value: string, configuredSecrets: ReadonlyArray<string>): string {
  return redactSensitiveText(value, configuredSecrets)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, "[REDACTED_URL]")
    .replace(
      /(?:\/(?:home|Users|var|tmp|private|opt|workspace)\/[^\s,;:'"<>]+|[A-Za-z]:\\[^\s,;:'"<>]+)/gu,
      "[REDACTED_PATH]",
    );
}

export function sanitizeRecord(
  input: Readonly<Record<string, unknown>>,
  configuredSecrets: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key) || DISALLOWED_PROPERTY_KEY.test(key)) continue;
    const sanitized = sanitizeValue(value, configuredSecrets);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function sanitizeReplayPayload(
  input: Readonly<Record<string, unknown>>,
  configuredSecrets: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const allowed = new Set([
    "$session_id",
    "$window_id",
    "$snapshot_data",
    "$snapshot_source",
    "$session_recording_start_reason",
  ]);
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => allowed.has(key))
      .map(([key, value]) => [key, sanitizeReplayValue(value, key, configuredSecrets)]),
  );
}

function sanitizeReplayValue(
  value: unknown,
  key: string,
  configuredSecrets: ReadonlyArray<string>,
): unknown {
  if (/attributes?/i.test(key)) {
    return sanitizeReplayAttributes(value, configuredSecrets);
  }
  if (
    SENSITIVE_KEY.test(key) ||
    /(?:text|prompt|message|content|transcript|terminal|diff|command|input|output|value|url|href|path|filename)/i.test(
      key,
    )
  ) {
    if (Array.isArray(value)) return [];
    if (value && typeof value === "object") return {};
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value, configuredSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReplayValue(entry, "", configuredSecrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeReplayValue(nestedValue, nestedKey, configuredSecrets),
      ]),
    );
  }
  return value;
}

function sanitizeReplayAttributes(
  value: unknown,
  configuredSecrets: ReadonlyArray<string>,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safeNames = new Set([
    "class",
    "style",
    "role",
    "aria-hidden",
    "width",
    "height",
    "viewBox",
    "preserveAspectRatio",
    "fill",
    "stroke",
    "d",
    "media",
    "rel",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([attribute, attributeValue]) =>
          safeNames.has(attribute) && typeof attributeValue === "string",
      )
      .map(([attribute, attributeValue]) => [
        attribute,
        sanitizeAnalyticsString(attributeValue as string, configuredSecrets),
      ]),
  );
}

export function makeBeforeSendSanitizer(input: {
  readonly configuredSecrets?: () => ReadonlyArray<string>;
  readonly enqueue: (
    event: string,
    properties: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>;
}) {
  return (
    capture: {
      readonly event?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
    } | null,
  ): null => {
    if (!capture?.event || !capture.properties) return null;
    if (!["$autocapture", "$$heatmap"].includes(capture.event)) return null;
    const properties =
      capture.event === "$autocapture"
        ? sanitizeAutocapturePayload(capture.properties)
        : sanitizeHeatmapPayload(capture.properties, input.configuredSecrets?.() ?? []);
    Promise.resolve(input.enqueue(capture.event, properties)).catch(() => undefined);
    return null;
  };
}

function sanitizeHeatmapPayload(
  properties: Readonly<Record<string, unknown>>,
  configuredSecrets: ReadonlyArray<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => ["$heatmap_data", "$session_id", "$window_id"].includes(key))
      .map(([key, value]) => [
        key,
        key === "$heatmap_data"
          ? sanitizeHeatmapData(value, configuredSecrets)
          : sanitizeReplayValue(value, key, configuredSecrets),
      ]),
  );
}

function sanitizeHeatmapData(
  value: unknown,
  configuredSecrets: ReadonlyArray<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([url, points]) => [
      `https://studybuddy.local${stripUrl(url)}`,
      sanitizeReplayValue(points, "", configuredSecrets),
    ]),
  );
}

function sanitizeAutocapturePayload(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const analyticsId = findAnalyticsId(properties);
  return {
    event_type: "click",
    ...(analyticsId ? { analytics_id: analyticsId } : {}),
  };
}

function findAnalyticsId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findAnalyticsId(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (
      /(?:^analytics[_-]id$|data[_-]analytics[_-]id|attr__data-analytics-id)/i.test(key) &&
      typeof nested === "string"
    ) {
      return nested.slice(0, 100);
    }
    const found = findAnalyticsId(nested);
    if (found) return found;
  }
  return null;
}
