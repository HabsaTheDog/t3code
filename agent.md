# Study Buddy 2.0 Agent Rules

- Keep all Moodle/CIS pipeline logic isolated under `src/custom-skills/moodle/`.
- Do not modify host routing, state, or UI files for the Moodle skill.
- Use the current 2.0 TypeScript contracts for Moodle data shapes, study-document expectations, quiz workflows, and Typst conventions.
- Govern the Moodle pipeline with LangGraph, not a linear script.
- Preserve the strict graph state fields: `moodle_raw_text`, `extracted_data`, `final_document`, `error_log`, and `retry_count`.
- Route invalid analyzer JSON back to the analyzer with `error_log` repair context.
- Route invalid Typst back to the formatter with validator diagnostics.
- Abort retry loops after three retries.
- Expose both a reusable TypeScript API and a CLI wrapper.
- Prefer live Moodle reads for current information; download linked files only as per-run artifacts when they add usable source text.
- Prefer live CIS reads for timetable, exam, administrative, and study-program information that Moodle does not expose.
- For dates, schedules, rooms, exams, and deadlines, use the personal calendar first when configured. One complete direct result from calendar, CIS, or Moodle is sufficient; do not start another run merely to corroborate it.
- Use CIS directly for attendance and administrative LV information. Use another source only when the primary source is unavailable, has no match, or lacks a requested field.
- Do not conclude that information is unavailable from one empty source; use the appropriate fallback and report source coverage.
- Never submit final Moodle quiz attempts.
