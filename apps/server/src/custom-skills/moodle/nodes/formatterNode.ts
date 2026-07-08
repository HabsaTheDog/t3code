import type { CodexClient } from "../codexClient.ts";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";
import { validateTypst } from "../validation.ts";
import {
  STUDY_BUDDY_TEMPLATE_FILE,
  STUDY_BUDDY_TYPST_TEMPLATE,
  studyBuddyTemplatePromptReference,
} from "../typstTemplate.ts";

export function createFormatterNode(config: MoodleRuntimeConfig, codex: CodexClient) {
  return async function formatterNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    try {
      const typst = await codex.run(buildFormatterPrompt(config, state));
      const document = stripTypstFence(typst);
      const validation = await validateTypst(document, [
        {
          relativePath: STUDY_BUDDY_TEMPLATE_FILE,
          content: STUDY_BUDDY_TYPST_TEMPLATE,
        },
      ]);
      if (!validation.ok) {
        return {
          final_document: appendFormatterWarning(document, validation.error),
          error_log: null,
        };
      }
      return {
        final_document: document,
        error_log: null,
      };
    } catch (error) {
      return {
        error_log: `Formatter failed: ${error instanceof Error ? error.message : String(error)}`,
        retry_count: state.retry_count + 1,
      };
    }
  };
}

function appendFormatterWarning(document: string, error: string): string {
  return `${document.trim()}\n\n// Typst validation warning passed through without blocking:\n// ${error.replace(/\n/g, "\n// ")}\n`;
}

function buildFormatterPrompt(config: MoodleRuntimeConfig, state: LangGraphAgentState): string {
  return [
    "Generate a complete Typst document for an engineering study note.",
    studyBuddyTemplatePromptReference(),
    "Return only Typst source. Do not include Markdown fences or explanation.",
    "Escape text content that is not Typst syntax.",
    "For Moodle+CIS runs, include a compact source coverage note that distinguishes Moodle facts from CIS facts.",
    "For schedule/date/lab/timetable questions, make the final answer actionable: date, time if available, course/session, preparation, tasks, and uncertainty.",
    isLabReportContextPrompt(config.prompt)
      ? [
          "This is a lab-report context request.",
          'Start the Typst document with a section titled "Copy-Paste Box".',
          "In that section, include a Typst raw text block containing a concise German copy-pasteable summary for the lab report header and preparation notes.",
          'Use explicit placeholders like "noch offen, aus CIS nachtragen" for missing date, time, room, group, or supervising lecturer facts.',
          "Do not hide missing Moodle or CIS coverage; include it inside the box as a short Quellenlage line.",
        ].join(" ")
      : "",
    state.error_log ? `Previous Typst validation error to repair:\n${state.error_log}` : "",
    `User request:\n${config.prompt}`,
    `Source coverage JSON:\n${JSON.stringify(state.source_coverage, null, 2)}`,
    `Extracted data JSON:\n${JSON.stringify(state.extracted_data, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stripTypstFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:typst|typ)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return `${(fenced?.[1] ?? trimmed).trim()}\n`;
}

function isLabReportContextPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /laborbericht|laborberricht|protokoll/.test(normalized) &&
    /termin|lektor|raum|gruppe|abgabe|key info|infos|vorgaben/.test(normalized)
  );
}
