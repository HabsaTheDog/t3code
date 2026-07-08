#!/usr/bin/env node
import { Command } from "commander";
import { runMoodleGraph } from "./graph.ts";
import { runSchemaSmoke } from "./schemaSmoke.ts";

const program = new Command()
  .name("moodle-agent")
  .description("Run the quarantined Moodle-to-Typst LangGraph skill.")
  .argument("[prompt]", "User request for the Moodle agent")
  .option("--url <url>", "Moodle URL to inspect")
  .option("--out <path>", "Output .typ path")
  .option("--max-depth <number>", "Maximum same-domain crawl depth", parseNumber, 1)
  .option("--max-pages <number>", "Maximum Moodle pages to inspect", parseNumber, 12)
  .option("--cis-url <url>", "CIS URL to inspect; repeat for multiple pages", collect, [])
  .option("--calendar-url <url>", "Private personal university iCalendar feed URL")
  .option("--max-cis-pages <number>", "Maximum CIS pages to inspect", parseNumber, 8)
  .option("--browser-backend <backend>", "Browser backend: agent-browser or playwright")
  .option("--browser-headed", "Show the browser window for Moodle/CIS scraping")
  .option("--keep-browser-open", "Keep the agent-browser session open after the run")
  .option(
    "--browser-max-output <number>",
    "Maximum characters returned by agent-browser page commands",
    parseNumber,
  )
  .option(
    "--auto-answer",
    "Accepted for quiz migration compatibility; 2.0 currently performs safe quiz review only",
  )
  .option("--no-downloads", "Do not capture linked files as run artifacts")
  .option(
    "--schema-smoke",
    "Validate the Codex structured-output schema without Moodle/CIS crawling",
  )
  .option("--codex-model <model>", "Codex model slug for Study Buddy LLM calls")
  .option("--json", "Print machine-readable JSON result")
  .parse(process.argv);

const options = program.opts<{
  url?: string;
  out?: string;
  maxDepth: number;
  maxPages: number;
  cisUrl: string[];
  calendarUrl?: string;
  maxCisPages: number;
  browserBackend?: "agent-browser" | "playwright";
  browserHeaded?: boolean;
  keepBrowserOpen?: boolean;
  browserMaxOutput?: number;
  autoAnswer?: boolean;
  downloads: boolean;
  schemaSmoke?: boolean;
  codexModel?: string;
  json?: boolean;
}>();

const prompt = program.args.join(" ");

if (options.schemaSmoke) {
  try {
    const data = await runSchemaSmoke();
    const result = { ok: true, data };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Structured-output schema smoke test passed.");
    }
  } catch (error) {
    const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(result.error);
    }
    process.exitCode = 1;
  }
  process.exit();
}

if (!prompt.trim()) {
  program.error("missing required argument 'prompt'");
}
const moodleUrl = options.url;
if (!moodleUrl) {
  program.error("required option '--url <url>' not specified");
  throw new Error("unreachable");
}

const result = await runMoodleGraph({
  prompt,
  moodleUrl,
  outputPath: options.out,
  maxDepth: options.maxDepth,
  maxPages: options.maxPages,
  cisUrls: options.cisUrl,
  calendarUrl: options.calendarUrl,
  maxCisPages: options.maxCisPages,
  allowFileDownloads: options.downloads,
  browserBackend: options.browserBackend,
  browserHeaded: options.browserHeaded,
  keepBrowserOpen: options.keepBrowserOpen,
  browserMaxOutput: options.browserMaxOutput,
  autoAnswer: options.autoAnswer,
  codexModel: options.codexModel,
});

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  if (result.outputPath) {
    console.log(`Wrote Typst document: ${result.outputPath}`);
  }
  if (result.answerPath) {
    console.log(`Wrote answer: ${result.answerPath}`);
  }
  if (result.answerJsonPath) {
    console.log(`Wrote answer data: ${result.answerJsonPath}`);
  }
  if (result.pdfPath) {
    console.log(`Wrote PDF document: ${result.pdfPath}`);
  }
} else {
  console.error(result.error || "Moodle graph failed.");
  process.exitCode = 1;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`);
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
