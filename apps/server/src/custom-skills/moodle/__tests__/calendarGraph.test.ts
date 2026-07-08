// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCalendarEvents } from "../calendarAdapter.ts";
import { buildMoodleGraph } from "../graph.ts";
import { initialAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = null;
});

describe("server calendar path", () => {
  it("parses a complete MEL exam from the private feed", async () => {
    const selection = await readCalendarEvents(
      "webcal://calendar.example/private-token",
      "Wann und wo ist die MEL1 Prüfung?",
      {
        now: new Date("2026-06-27T10:00:00.000Z"),
        fetchImpl: vi.fn(async () => new Response(calendarFixture())),
      },
    );
    expect(selection.complete).toBe(true);
    expect(selection.events[0]).toMatchObject({
      title: "MEL1 Prüfung",
      start: "2026-07-01T07:00:00.000Z",
      location: "A1.01",
    });
  });

  it("skips Moodle, CIS, and analyzer for a complete pure schedule answer", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "t3-calendar-"));
    const config = testConfig(runDir);
    let analyzerCalls = 0;
    const graph = buildMoodleGraph(config, {
      calendarNode: async (state) => {
        config.calendarSelection = {
          status: "success",
          complete: true,
          missingFields: [],
          needsCisFallback: false,
          detail: "Selected one event.",
          events: [
            {
              source: "calendar_event",
              uid: "mel-exam",
              title: "MEL1 Prüfung",
              start: "2026-07-01T07:00:00.000Z",
              end: "2026-07-01T08:30:00.000Z",
              location: "A1.01",
              allDay: false,
              recurring: false,
            },
          ],
        };
        return {
          moodle_raw_text: "[Calendar event]\nTitle: MEL1 Prüfung",
          source_coverage: {
            ...state.source_coverage,
            calendar: {
              status: "success",
              detail: "Selected one event.",
              urls: [],
              pages: 1,
            },
          },
          error_log: null,
        };
      },
      scraperNode: async () => {
        throw new Error("Moodle must not run");
      },
      cisScraperNode: async () => {
        throw new Error("CIS must not run");
      },
      codex: {
        async run() {
          analyzerCalls += 1;
          throw new Error("Analyzer must not run");
        },
      },
    });

    const result = await graph.invoke(initialAgentState);
    const answerJson = await readFile(path.join(runDir, "answer.json"), "utf8");
    expect(result.error_log).toBeNull();
    expect(analyzerCalls).toBe(0);
    expect(answerJson).toContain('"kind": "calendar_event"');
    expect(answerJson).not.toContain("private-token");
  });
});

function testConfig(directory: string): MoodleRuntimeConfig {
  return {
    prompt: "Wann und in welchem Raum ist die MEL1 Prüfung?",
    moodleUrl: "https://moodle.example/my",
    outputPath: path.join(directory, "document.typ"),
    runDir: directory,
    maxDepth: 0,
    maxPages: 1,
    maxCisPages: 1,
    allowFileDownloads: false,
    baseUrl: "https://moodle.example",
    dashboardUrl: "https://moodle.example/my",
    cisUrls: ["https://cis.example/cis.php"],
    calendarUrl: "https://calendar.example/private-token",
    cisBaseUrl: "https://cis.example",
    cisDashboardUrl: "https://cis.example/cis.php",
    headless: true,
  };
}

function calendarFixture(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Vienna",
    "BEGIN:DAYLIGHT",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:mel-exam",
    "DTSTART;TZID=Europe/Vienna:20260701T090000",
    "DTEND;TZID=Europe/Vienna:20260701T103000",
    "SUMMARY:MEL1 Prüfung",
    "LOCATION:A1.01",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
