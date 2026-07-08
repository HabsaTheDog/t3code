import { createCodexClient, type CodexClient } from "./codexClient.ts";
import { extractedDataJsonSchema } from "./schemas.ts";
import { parseJsonObjectOrArray, validateExtractedData } from "./validation.ts";
import type { MoodleRuntimeConfig } from "./types.ts";

const SCHEMA_SMOKE_PROMPT = [
  "Return only minimal valid JSON for the requested Moodle extracted-data schema.",
  "Use a non-empty document_title.",
  "Use empty arrays where there is no content.",
  "Use null for optional source url/path/page fields when they are absent.",
].join("\n");

export async function runSchemaSmoke(codex: CodexClient = createCodexClient(schemaSmokeConfig())) {
  const response = await codex.run(SCHEMA_SMOKE_PROMPT, {
    outputSchema: extractedDataJsonSchema,
  });
  return validateExtractedData(parseJsonObjectOrArray(response));
}

function schemaSmokeConfig(): MoodleRuntimeConfig {
  return {
    prompt: "Schema smoke test",
    moodleUrl: "https://moodle.invalid/",
    outputPath: "document.typ",
    runDir: process.cwd(),
    maxDepth: 0,
    maxPages: 0,
    maxCisPages: 0,
    allowFileDownloads: false,
    baseUrl: "https://moodle.invalid",
    dashboardUrl: "https://moodle.invalid/",
    cisUrls: [],
    cisBaseUrl: "https://cis.invalid",
    cisDashboardUrl: "https://cis.invalid/",
    headless: true,
  };
}
