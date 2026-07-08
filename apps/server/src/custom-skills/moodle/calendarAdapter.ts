// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { writeFile } from "node:fs/promises";
import path from "node:path";
import ICAL from "ical.js";

export const CALENDAR_MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const HORIZON_DAYS = 400;
const MAX_EVENTS = 10;
const TIME_ZONE = "Europe/Vienna";

export interface CalendarEvent {
  source: "calendar_event";
  uid: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  recurring: boolean;
}

export interface CalendarSelection {
  status: "success" | "empty" | "failed";
  events: CalendarEvent[];
  complete: boolean;
  missingFields: string[];
  needsCisFallback: boolean;
  detail: string;
}

export interface CalendarAdapterOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const COURSE_ALIASES: Record<string, string[]> = {
  MEL: ["mel", "mel1", "maschinenelemente", "maschinenelemente 1"],
  DYN2: ["dyn2", "anwendungen der dynamik"],
  PHDYN: ["phdyn", "physikalische grundlagen der dynamik"],
  MAES2: ["maes2", "mathematik für engineering science 2", "mathematik"],
  ETLB2: ["etlb2", "elektrotechnik labor 2"],
};
const EXAM = /\b(?:prüfung|pruefung|test|exam|klausur)\b/i;
const SCHEDULE =
  /\b(?:termin|prüfung|pruefung|test|exam|klausur|uhrzeit|raum|räume|raeume|wann|wo|heute|morgen|diese woche|deadline|frist|stundenplan|schedule|timetable|today|tomorrow|room)\b/i;
const MATERIAL =
  /\b(?:moodle|unterlagen|kursmaterial|folie|folien|skript|pdf|datei|lernzettel|formelsammlung|übungsblatt|uebungsblatt|quiz|assignment|aufgabenstellung|fachlabor|laborinhalt)\b|was machen wir|what are we doing/i;
const ADMIN =
  /\b(?:anwesenheit|attendance|lv-info|lehrveranstaltungsinformation|administrativ|ects|lehrende|dozent|syllabus)\b/i;

export function isCalendarRequest(prompt: string): boolean {
  return SCHEDULE.test(prompt);
}

export function isPureScheduleRequest(prompt: string): boolean {
  return isCalendarRequest(prompt) && !MATERIAL.test(prompt) && !requiresCisDirectly(prompt);
}

export function requiresCisDirectly(prompt: string): boolean {
  return ADMIN.test(prompt);
}

export async function readCalendarEvents(
  calendarUrl: string,
  prompt: string,
  options: CalendarAdapterOptions = {},
): Promise<CalendarSelection> {
  const now = options.now ?? new Date();
  try {
    const text = await fetchCalendarText(normalizeCalendarUrl(calendarUrl), options);
    const events = filterCalendarEvents(parseCalendarEvents(text, now), prompt, now);
    const missingFields = requiredMissingFields(prompt, events[0]);
    const complete = events.length > 0 && missingFields.length === 0;
    return {
      status: events.length > 0 ? "success" : "empty",
      events,
      complete,
      missingFields,
      needsCisFallback: !complete,
      detail:
        events.length > 0
          ? `Selected ${events.length} relevant calendar event(s).`
          : "Calendar was readable, but no matching event was found.",
    };
  } catch (error) {
    return {
      status: "failed",
      events: [],
      complete: false,
      missingFields: [],
      needsCisFallback: true,
      detail: safeError(error),
    };
  }
}

export function normalizeCalendarUrl(value: string): string {
  const parsed = new URL(value.trim().replace(/^webcal:\/\//i, "https://"));
  if (parsed.protocol !== "https:") throw new Error("Calendar feed must use HTTPS or webcal.");
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export async function fetchCalendarText(
  url: string,
  options: CalendarAdapterOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? CALENDAR_MAX_BYTES;
  try {
    let currentUrl = normalizeCalendarUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImpl(currentUrl, {
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
      if (Number(response.headers.get("content-length") || "0") > maxBytes) {
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
        if (total > maxBytes) {
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

export function parseCalendarEvents(ics: string, now = new Date()): CalendarEvent[] {
  let calendar: InstanceType<typeof ICAL.Component>;
  try {
    calendar = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new Error("Calendar feed is not valid iCalendar data.");
  }
  if (calendar.name !== "vcalendar") throw new Error("Calendar feed has no VCALENDAR.");
  const windowStart = new Date(now.getTime() - 86_400_000);
  const windowEnd = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);
  const result: CalendarEvent[] = [];
  const events = calendar
    .getAllSubcomponents("vevent")
    .map((component) => new ICAL.Event(component))
    .filter((event) => !event.isRecurrenceException());
  for (const event of events) {
    if (cancelled(event)) continue;
    if (!event.isRecurring()) {
      push(result, event, event.startDate, event.endDate, false, windowStart, windowEnd);
      continue;
    }
    const iterator = event.iterator();
    let occurrence: InstanceType<typeof ICAL.Time> | null;
    let safety = 0;
    while ((occurrence = iterator.next()) && safety < 20_000) {
      safety += 1;
      const details = event.getOccurrenceDetails(occurrence);
      if (details.startDate.toJSDate() > windowEnd) break;
      if (!cancelled(details.item)) {
        push(
          result,
          details.item,
          details.startDate,
          details.endDate,
          true,
          windowStart,
          windowEnd,
        );
      }
    }
  }
  const seen = new Set<string>();
  return result
    .filter((event) => {
      const key = `${event.uid}\0${event.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareEvents);
}

export function filterCalendarEvents(
  events: CalendarEvent[],
  prompt: string,
  now = new Date(),
): CalendarEvent[] {
  const range = requestedRange(prompt, now);
  const terms = courseTerms(prompt);
  return events
    .filter((event) => {
      const start = new Date(event.start);
      return start >= range.start && start <= range.end;
    })
    .filter((event) => terms.length === 0 || terms.some((term) => eventText(event).includes(term)))
    .filter((event) => !EXAM.test(prompt) || EXAM.test(eventText(event)))
    .sort(compareEvents)
    .slice(0, MAX_EVENTS);
}

export function formatCalendarEventsForWorkflow(events: CalendarEvent[]): string {
  return events
    .map((event) =>
      [
        "[Calendar event]",
        `Source kind: ${event.source}`,
        `Title: ${event.title}`,
        `Start: ${event.start}`,
        `End: ${event.end}`,
        `All day: ${event.allDay ? "yes" : "no"}`,
        event.location ? `Location: ${event.location}` : "",
        event.description ? `Description: ${event.description}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export function formatCalendarAnswer(events: CalendarEvent[]): string {
  return events.length === 0
    ? "Kein passender Termin im persönlichen Uni-Kalender gefunden."
    : events
        .map((event) => {
          const start = new Date(event.start);
          const end = new Date(event.end);
          const date = new Intl.DateTimeFormat("de-AT", {
            timeZone: TIME_ZONE,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          }).format(start);
          const time = event.allDay ? "ganztägig" : `${clock(start)}–${clock(end)} Uhr`;
          return `${event.title}: ${date}, ${time}${event.location ? `, ${event.location}` : ""}`;
        })
        .join("\n");
}

export async function writeFilteredCalendarArtifact(
  runDir: string,
  events: CalendarEvent[],
): Promise<string> {
  const file = path.join(runDir, "calendar-events.json");
  await writeFile(file, `${JSON.stringify(events, null, 2)}\n`, "utf8");
  return file;
}

function push(
  target: CalendarEvent[],
  event: InstanceType<typeof ICAL.Event>,
  startTime: InstanceType<typeof ICAL.Time>,
  endTime: InstanceType<typeof ICAL.Time>,
  recurring: boolean,
  windowStart: Date,
  windowEnd: Date,
): void {
  const start = startTime.toJSDate();
  const end = endTime.toJSDate();
  if (end < windowStart || start > windowEnd) return;
  const title = event.summary?.trim() || "Termin";
  target.push({
    source: "calendar_event",
    uid: event.uid || `${title}-${start.toISOString()}`,
    title,
    ...(event.description?.trim() ? { description: event.description.trim() } : {}),
    ...(event.location?.trim() ? { location: event.location.trim() } : {}),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: startTime.isDate,
    recurring,
  });
}

function cancelled(event: InstanceType<typeof ICAL.Event>): boolean {
  return (
    String(event.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED"
  );
}

function courseTerms(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const terms = new Set<string>();
  for (const aliases of Object.values(COURSE_ALIASES)) {
    if (aliases.some((alias) => lower.includes(alias)))
      aliases.forEach((alias) => terms.add(alias));
  }
  for (const code of prompt.match(/\b[A-ZÄÖÜ]{2,8}\d{0,3}\b/g) ?? []) {
    if (!["PDF", "CIS", "URL", "FH", "LV", "SS", "WS", "DC"].includes(code)) {
      terms.add(code.toLowerCase());
    }
  }
  return [...terms];
}

function requiredMissingFields(prompt: string, event?: CalendarEvent): string[] {
  if (!event) return [];
  const missing: string[] = [];
  if (!event.start) missing.push("date");
  if ((/\b(?:uhrzeit|time|wann)\b/i.test(prompt) || EXAM.test(prompt)) && event.allDay) {
    missing.push("time");
  }
  if (/\b(?:raum|räume|raeume|room|wo)\b/i.test(prompt) && !event.location) missing.push("room");
  return missing;
}

function requestedRange(prompt: string, now: Date): { start: Date; end: Date } {
  const today = dateKey(now);
  if (/\b(?:heute|today)\b/i.test(prompt)) return keyRange(today);
  if (/\b(?:morgen|tomorrow)\b/i.test(prompt)) return keyRange(addDays(today, 1));
  if (/\b(?:diese woche|this week)\b/i.test(prompt)) {
    const day = parseKey(today).getUTCDay() || 7;
    const monday = addDays(today, 1 - day);
    return { start: keyRange(monday).start, end: keyRange(addDays(monday, 6)).end };
  }
  return { start: now, end: new Date(now.getTime() + HORIZON_DAYS * 86_400_000) };
}

function keyRange(key: string): { start: Date; end: Date } {
  const start = midnight(key);
  return { start, end: new Date(midnight(addDays(key, 1)).getTime() - 1) };
}

function midnight(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(guess));
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += Date.UTC(year, month - 1, day) - observed;
  }
  return new Date(guess);
}

function dateKey(date: Date): string {
  const parts = zonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function zonedParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function addDays(key: string, days: number): string {
  const date = parseKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseKey(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function eventText(event: CalendarEvent): string {
  return `${event.title} ${event.description ?? ""} ${event.location ?? ""}`.toLowerCase();
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return a.start.localeCompare(b.start) || a.title.localeCompare(b.title, "de");
}

function clock(date: Date): string {
  return new Intl.DateTimeFormat("de-AT", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /(?:webcal|https):\/\/\S+/gi,
    "[redacted calendar URL]",
  );
}
