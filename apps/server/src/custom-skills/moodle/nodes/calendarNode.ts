import {
  formatCalendarEventsForWorkflow,
  readCalendarEvents,
  writeFilteredCalendarArtifact,
} from "../calendarAdapter.ts";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

export function createCalendarNode(config: MoodleRuntimeConfig) {
  return async function calendarNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    if (!config.calendarUrl) {
      return {
        source_coverage: {
          ...state.source_coverage,
          calendar: {
            status: "not_requested",
            detail: "No personal calendar feed was configured.",
            urls: [],
            pages: 0,
          },
        },
      };
    }
    const selection = await readCalendarEvents(config.calendarUrl, config.prompt);
    config.calendarSelection = selection;
    await writeFilteredCalendarArtifact(config.runDir, selection.events);
    return {
      moodle_raw_text: formatCalendarEventsForWorkflow(selection.events),
      source_coverage: {
        ...state.source_coverage,
        calendar: {
          status: selection.status,
          detail: selection.detail,
          urls: [],
          pages: selection.events.length,
        },
      },
      error_log: null,
    };
  };
}
