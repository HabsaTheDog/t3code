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
const SAFE_SETTINGS_SECTIONS = new Set([
  "archived",
  "cloud",
  "connections",
  "diagnostics",
  "execution-profiles",
  "general",
  "keybindings",
  "privacy",
  "providers",
  "source-control",
  "study-buddy",
]);

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

export function safeHeatmapPath(value: string): string {
  try {
    const url = new URL(value, "https://local.invalid");
    const pathname = url.pathname;
    if (pathname === "/") return "/home";
    if (pathname.startsWith("/chat") || pathname.startsWith("/_chat")) return "/chat";
    if (pathname.startsWith("/pair")) return "/pair";
    if (pathname.startsWith("/setup")) return "/setup";
    if (pathname.startsWith("/settings/")) {
      const section = pathname.split("/")[2]?.toLowerCase();
      return section && SAFE_SETTINGS_SECTIONS.has(section) ? `/settings/${section}` : "/settings";
    }
    if (pathname.startsWith("/settings")) return "/settings";
    return "/application";
  } catch {
    return "/application";
  }
}

export function canonicalHeatmapUrl(value: string): string {
  const route = safeHeatmapPath(value);
  const displayPath =
    route === "/chat" || route === "/home" || route === "/application" || route === "/setup"
      ? "/_chat/"
      : route;
  return `https://app.t3.codes${displayPath}`;
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
        : sanitizeHeatmapPayload(capture.properties);
    if (properties) {
      Promise.resolve(input.enqueue(capture.event, properties)).catch(() => undefined);
    }
    return null;
  };
}

function sanitizeHeatmapPayload(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const heatmapData = sanitizeHeatmapData(properties.$heatmap_data);
  const viewportWidth = sanitizeViewportDimension(properties.$viewport_width);
  const viewportHeight = sanitizeViewportDimension(properties.$viewport_height);
  // PostHog's dedicated heatmap ingestion pipeline drops otherwise valid points when either
  // viewport dimension is absent, so reject the batch locally instead of pretending it shipped.
  if (Object.keys(heatmapData).length === 0 || !viewportWidth || !viewportHeight) return null;
  return {
    $heatmap_data: heatmapData,
    $viewport_width: viewportWidth,
    $viewport_height: viewportHeight,
    ...(typeof properties.$session_id === "string"
      ? { $session_id: properties.$session_id.slice(0, 100) }
      : {}),
    ...(typeof properties.$window_id === "string"
      ? { $window_id: properties.$window_id.slice(0, 100) }
      : {}),
  };
}

function sanitizeViewportDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(100_000, Math.round(value));
}

function sanitizeHeatmapData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const [url, points] of Object.entries(value)) {
    const safePoints = sanitizeHeatmapPoints(points);
    if (safePoints.length === 0) continue;
    const safeUrl = canonicalHeatmapUrl(url);
    sanitized[safeUrl] = [...(sanitized[safeUrl] ?? []), ...safePoints].slice(0, 2_000);
  }
  return sanitized;
}

function sanitizeHeatmapPoints(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2_000).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const point = candidate as Readonly<Record<string, unknown>>;
    if (point.type !== "click" && point.type !== "deadclick" && point.type !== "rageclick") {
      return [];
    }
    if (
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      point.x < 0 ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y) ||
      point.y < 0
    ) {
      return [];
    }
    return [
      {
        x: Math.min(100_000, Math.round(point.x)),
        y: Math.min(1_000_000, Math.round(point.y)),
        type: point.type,
        ...(typeof point.target_fixed === "boolean" ? { target_fixed: point.target_fixed } : {}),
      },
    ];
  });
}

function sanitizeAutocapturePayload(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const analyticsId = findAnalyticsId(properties);
  if (!analyticsId) return null;
  return {
    event_type: "click",
    analytics_id: analyticsId,
    route: safeHeatmapPath(
      typeof properties.$current_url === "string" ? properties.$current_url : "/application",
    ).slice(1),
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
      const normalized = nested
        .trim()
        .replace(/[^a-z0-9._:-]+/giu, "_")
        .slice(0, 100);
      return normalized || null;
    }
    const found = findAnalyticsId(nested);
    if (found) return found;
  }
  return null;
}
