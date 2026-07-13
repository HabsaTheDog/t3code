import type { CodexClient } from "../codexClient.ts";
import { extractedDataJsonSchema } from "../schemas.ts";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";
import { parseJsonObjectOrArray, validateExtractedData } from "../validation.ts";
import { redactSensitiveValues } from "../browserSecurity.ts";

export function createAnalyzerNode(config: MoodleRuntimeConfig, codex: CodexClient) {
  return async function analyzerNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    try {
      const response = await codex.run(buildAnalyzerPrompt(config, state), {
        outputSchema: extractedDataJsonSchema,
      });
      const parsed = parseJsonObjectOrArray(response);
      const validated = validateExtractedData(parsed);
      return {
        extracted_data: validated,
        error_log: null,
      };
    } catch (error) {
      return {
        error_log: `Analyzer failed: ${error instanceof Error ? error.message : String(error)}`,
        retry_count: state.retry_count + 1,
      };
    }
  };
}

function buildAnalyzerPrompt(config: MoodleRuntimeConfig, state: LangGraphAgentState): string {
  const prompt = [
    "Extract structured study data from selected calendar events and relevant Moodle/CIS text for a mechatronics/engineering student.",
    "Return only JSON matching the requested schema. Do not include Markdown fences.",
    "Preserve German source language unless the user asks otherwise.",
    "Represent formulas in Typst math syntax where possible.",
    "Never invent source citations.",
    "Use calendar, Moodle, and CIS according to their source roles.",
    "For timetable, date, room, exam, 'tomorrow', or 'today' questions, the personal calendar is primary; CIS is required when the calendar is unavailable, has no match, lacks a requested field, or the request asks for attendance or administrative LV information.",
    "The calendar input is already filtered; never infer events that are not present.",
    "For course material, assignments, announcements, Moodle calendar entries, forums, and downloadable files, Moodle is required.",
    "If a requested fact is absent in Moodle but present in CIS, state that distinction in warnings and cite CIS.",
    "If CIS is inaccessible or empty, state that limitation in warnings and do not claim the information does not exist overall.",
    "If Moodle is inaccessible or empty, state that limitation in warnings and do not claim the information does not exist overall.",
    "Use the source coverage JSON as a hard boundary: failed or empty sources can only support warnings, not factual claims.",
    "When both Moodle and CIS contain related facts, combine them into one answer and keep the source ids distinguishable.",
    state.error_log ? `Previous validation error to repair:\n${state.error_log}` : "",
    `User request:\n${config.prompt}`,
    `Source coverage JSON:\n${JSON.stringify(state.source_coverage, null, 2)}`,
    `Moodle/CIS source text:\n${state.moodle_raw_text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return redactSensitiveValues(prompt, [
    config.username,
    config.password,
    config.cisUsername,
    config.cisPassword,
    config.calendarUrl,
  ]);
}
