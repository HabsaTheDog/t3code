// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalFetch:off -- This isolated connection probe performs a bounded one-shot HTTPS fetch.
import ICAL from "ical.js";
import { assertPublicHttpsUrl } from "./browserSecurity.ts";

const CALENDAR_MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export function normalizeCalendarUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Calendar URL is empty.");
  const normalized = trimmed.replace(/^webcal:/i, "https:");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:") throw new Error("Calendar URL must use HTTPS.");
  return parsed.toString();
}

export async function fetchCalendarText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let currentUrl = normalizeCalendarUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicHttpsUrl(currentUrl);
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { accept: "text/calendar, text/plain;q=0.9" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Calendar redirect failed.");
        currentUrl = normalizeCalendarUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Calendar request failed with HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length") || "0") > CALENDAR_MAX_BYTES) {
        throw new Error("Calendar feed exceeds the 5 MiB limit.");
      }
      if (!response.body) throw new Error("Calendar response has no body.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > CALENDAR_MAX_BYTES) {
          await reader.cancel();
          throw new Error("Calendar feed exceeds the 5 MiB limit.");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }
    throw new Error("Calendar redirect limit exceeded.");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Calendar request timed out.", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function validateCalendarText(ics: string): void {
  let calendar: InstanceType<typeof ICAL.Component>;
  try {
    calendar = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new Error("Calendar feed is not valid iCalendar data.");
  }
  if (calendar.name !== "vcalendar") throw new Error("Calendar feed has no VCALENDAR.");
}
