import { canonicalHeatmapUrl } from "./sanitize";

interface ClickLikeEvent {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly pageX?: number;
  readonly pageY?: number;
  readonly target?: EventTarget | null;
}

interface HeatmapDocument {
  readonly addEventListener: Document["addEventListener"];
  readonly removeEventListener: Document["removeEventListener"];
}

interface HeatmapWindow {
  readonly location: Pick<Location, "href">;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly getComputedStyle: Window["getComputedStyle"];
}

export interface PrivacySafeHeatmapCollectorOptions {
  readonly emit: (properties: Readonly<Record<string, unknown>>) => void;
  readonly emitControlClick?: (properties: Readonly<Record<string, unknown>>) => void;
  readonly document?: HeatmapDocument;
  readonly window?: HeatmapWindow;
  readonly intervalMs?: number;
  readonly sessionId?: string;
}

const MAX_POINTS_PER_ROUTE = 2_000;

export class PrivacySafeHeatmapCollector {
  readonly #emit: PrivacySafeHeatmapCollectorOptions["emit"];
  readonly #emitControlClick: PrivacySafeHeatmapCollectorOptions["emitControlClick"];
  readonly #document: HeatmapDocument | undefined;
  readonly #window: HeatmapWindow | undefined;
  readonly #intervalMs: number;
  readonly #sessionId: string | undefined;
  #buffer: Record<string, Array<Record<string, unknown>>> = {};
  #interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: PrivacySafeHeatmapCollectorOptions) {
    this.#emit = options.emit;
    this.#emitControlClick = options.emitControlClick;
    this.#document = options.document ?? (typeof document === "undefined" ? undefined : document);
    this.#window = options.window ?? (typeof window === "undefined" ? undefined : window);
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#sessionId = options.sessionId;
  }

  start(): void {
    if (!this.#document || !this.#window || this.#interval !== null) return;
    this.#document.addEventListener("click", this.#onClick, { capture: true });
    this.#interval = setInterval(() => this.flush(), this.#intervalMs);
  }

  stop(): void {
    this.#document?.removeEventListener("click", this.#onClick, { capture: true });
    if (this.#interval !== null) clearInterval(this.#interval);
    this.#interval = null;
    this.#buffer = {};
  }

  flush(): void {
    if (Object.keys(this.#buffer).length === 0) return;
    const heatmapData = this.#buffer;
    this.#buffer = {};
    const viewportWidth = finiteDimension(this.#window?.innerWidth);
    const viewportHeight = finiteDimension(this.#window?.innerHeight);
    if (!viewportWidth || !viewportHeight) return;
    this.#emit({
      $heatmap_data: heatmapData,
      $viewport_width: viewportWidth,
      $viewport_height: viewportHeight,
      ...(this.#sessionId ? { $session_id: this.#sessionId } : {}),
    });
  }

  readonly #onClick = (event: Event): void => {
    if (!this.#window) return;
    const click = event as ClickLikeEvent;
    const analyticsId = analyticsIdFromTarget(click.target);
    if (analyticsId) {
      this.#emitControlClick?.({
        analytics_id: analyticsId,
        // Never hand a thread id, query string, or project path to the SDK boundary.
        $current_url: canonicalHeatmapUrl(this.#window.location.href),
      });
    }
    if (!finiteCoordinate(click.clientX) || !finiteCoordinate(click.clientY)) return;
    const targetFixed = isFixedOrSticky(click.target, this.#window);
    const x = targetFixed
      ? click.clientX
      : finiteCoordinate(click.pageX)
        ? click.pageX
        : click.clientX + this.#window.scrollX;
    const y = targetFixed
      ? click.clientY
      : finiteCoordinate(click.pageY)
        ? click.pageY
        : click.clientY + this.#window.scrollY;
    const route = canonicalHeatmapUrl(this.#window.location.href);
    const points = (this.#buffer[route] ??= []);
    if (points.length >= MAX_POINTS_PER_ROUTE) return;
    points.push({
      x: Math.round(x),
      y: Math.round(y),
      type: "click",
      target_fixed: targetFixed,
    });
  };
}

function analyticsIdFromTarget(target: EventTarget | null | undefined): string | null {
  let element = elementLike(target);
  for (let depth = 0; element && depth < 20; depth += 1) {
    const value = element.getAttribute("data-analytics-id")?.trim();
    if (value) return value;
    element = elementLike(element.parentElement);
  }
  return null;
}

function elementLike(value: unknown): {
  readonly getAttribute: (name: string) => string | null;
  readonly parentElement: unknown;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    readonly getAttribute?: unknown;
    readonly parentElement?: unknown;
  };
  if (typeof candidate.getAttribute !== "function") return null;
  return {
    getAttribute: candidate.getAttribute.bind(value) as (name: string) => string | null,
    parentElement: candidate.parentElement,
  };
}

function finiteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(100_000, Math.round(value));
}

function isFixedOrSticky(target: EventTarget | null | undefined, host: HeatmapWindow): boolean {
  let element = typeof Element !== "undefined" && target instanceof Element ? target : null;
  while (element && element.tagName.toLowerCase() !== "body") {
    const position = host.getComputedStyle(element).position;
    if (position === "fixed" || position === "sticky") return true;
    element = element.parentElement;
  }
  return false;
}
