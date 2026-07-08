// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatCalendarAnswer } from "../calendarAdapter.ts";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

export function createCalendarAnswerNode(config: MoodleRuntimeConfig) {
  return async function calendarAnswerNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    const events = config.calendarSelection?.events ?? [];
    const answer = formatCalendarAnswer(events);
    const artifact = {
      schemaVersion: 1,
      kind: "schedule_answer",
      prompt: config.prompt,
      answer,
      status: config.calendarSelection?.complete ? "answered" : "partial",
      confidence: config.calendarSelection?.complete ? "high" : "low",
      sources: events.map((event) => ({ kind: "calendar_event", title: event.title })),
      missing: config.calendarSelection?.missingFields ?? [],
      generatedAt: new Date().toISOString(),
    };
    await mkdir(config.runDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(config.runDir, "answer.md"), `${answer}\n`, "utf8"),
      writeFile(
        path.join(config.runDir, "answer.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
        "utf8",
      ),
    ]);
    return { final_document: answer, error_log: state.error_log };
  };
}
