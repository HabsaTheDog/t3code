import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMoodleGraph, persistRunDiagnostics } from "../graph.ts";
import type { CodexClient } from "../codexClient.ts";
import { initialAgentState, initialSourceCoverage } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";
import { STUDY_BUDDY_TEMPLATE_FILE } from "../typstTemplate.ts";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("moodle graph retry routing", () => {
  it("continues past invalid analyzer JSON and writes Typst", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-run-"));
    const outputPath = path.join(runDir, "document.typ");
    const codex = sequenceCodex(["not json", "#set page()\n= Raw preserved\n"]);

    const graph = buildMoodleGraph(
      {
        prompt: "make notes",
        moodleUrl: "https://moodle.example/course",
        outputPath,
        runDir,
        maxDepth: 0,
        maxPages: 1,
        maxCisPages: 1,
        allowFileDownloads: false,
        baseUrl: "https://moodle.example",
        dashboardUrl: "https://moodle.example/my",
        cisUrls: [],
        cisBaseUrl: "https://cis.example",
        cisDashboardUrl: "https://cis.example",
        headless: true,
      },
      {
        codex,
        scraperNode: async (state) => ({
          moodle_raw_text: state.moodle_raw_text,
          source_coverage: {
            ...state.source_coverage,
            moodle: {
              status: "success",
              detail: "test fixture",
              urls: ["https://moodle.example/course"],
              pages: 1,
            },
          },
          error_log: null,
        }),
      },
    );

    const result = await graph.invoke({
      ...initialAgentState,
      moodle_raw_text: "local fixture text",
    });
    expect(result.error_log).toBeNull();
    expect(result.retry_count).toBe(0);
    await expect(readFile(outputPath, "utf8")).resolves.toContain("Raw preserved");
  });

  it("passes combined Moodle and CIS coverage to the analyzer for schedule requests", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-run-"));
    const outputPath = path.join(runDir, "document.typ");
    const prompts: string[] = [];
    const codex: CodexClient = {
      async run(prompt) {
        prompts.push(prompt);
        return prompts.length === 1
          ? JSON.stringify(validScheduleExtractedData())
          : "#set page()\n= Termininfo\n";
      },
    };

    const graph = buildMoodleGraph(
      {
        prompt: "Was machen wir morgen im Fachlabor und in welchem Raum?",
        moodleUrl: "https://moodle.example/my",
        outputPath,
        runDir,
        maxDepth: 0,
        maxPages: 1,
        maxCisPages: 1,
        allowFileDownloads: false,
        baseUrl: "https://moodle.example",
        dashboardUrl: "https://moodle.example/my",
        cisUrls: ["https://cis.example/cis.php"],
        cisBaseUrl: "https://cis.example",
        cisDashboardUrl: "https://cis.example/cis.php",
        headless: true,
      },
      {
        codex,
        scraperNode: async (state) => ({
          moodle_raw_text: "Moodle announcement text",
          source_coverage: {
            ...state.source_coverage,
            moodle: {
              status: "success",
              detail: "test moodle fixture",
              urls: ["https://moodle.example/my"],
              pages: 1,
            },
          },
          error_log: null,
        }),
        cisScraperNode: async (state) => ({
          moodle_raw_text: `${state.moodle_raw_text}\n\n[CIS page]\nTitle: Timetable\nURL: https://cis.example/cis.php\n\ncis timetable text`,
          source_coverage: {
            ...state.source_coverage,
            cis: {
              status: "success",
              detail: "test cis fixture",
              urls: ["https://cis.example/cis.php"],
              pages: 1,
            },
          },
          error_log: null,
        }),
      },
    );

    const result = await graph.invoke(initialAgentState);

    expect(result.error_log).toBeNull();
    expect(prompts[0]).toContain("CIS is required");
    expect(prompts[1]).toContain(STUDY_BUDDY_TEMPLATE_FILE);
    expect(prompts[1]).toContain("A4 only");
    expect(prompts[1]).toContain("ä, ö, ü");
    expect(prompts[0]).toContain("Moodle announcement text");
    expect(prompts[0]).toContain("cis timetable text");
    expect(prompts[0]).toContain('"cis"');
    await expect(readFile(outputPath, "utf8")).resolves.toContain("Termininfo");
  });
});

describe("moodle graph diagnostics", () => {
  it("writes sanitized run artifacts for failed runs", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-run-"));
    const config = testConfig(runDir);

    await persistRunDiagnostics(config, {
      moodle_raw_text: "raw moodle/cis text",
      source_coverage: {
        ...initialSourceCoverage,
        moodle: {
          status: "failed",
          detail: "Moodle failed",
          urls: ["https://moodle.example/course"],
          pages: 0,
        },
      },
      extracted_data: {},
      final_document: "",
      error_log: "Analyzer failed",
      retry_count: 3,
    });

    await expect(readFile(path.join(runDir, "moodle_raw.txt"), "utf8")).resolves.toBe(
      "raw moodle/cis text",
    );
    await expect(readFile(path.join(runDir, "error.log"), "utf8")).resolves.toBe("Analyzer failed");
    await expect(readFile(path.join(runDir, "source_coverage.json"), "utf8")).resolves.toContain(
      "Moodle failed",
    );
    await expect(readFile(path.join(runDir, "schema.json"), "utf8")).resolves.toContain(
      "additionalProperties",
    );

    const configJson = await readFile(path.join(runDir, "config.json"), "utf8");
    expect(configJson).toContain('"hasUsername": true');
    expect(configJson).toContain('"hasPassword": true');
    expect(configJson).toContain('"hasCalendarUrl": true');
    expect(configJson).not.toContain("secret-user");
    expect(configJson).not.toContain("secret-pass");
    expect(configJson).not.toContain("private-calendar-token");
  });
});

function sequenceCodex(outputs: string[]): CodexClient {
  let index = 0;
  return {
    async run() {
      const output = outputs[index];
      index += 1;
      if (output === undefined) {
        throw new Error("No mock Codex output left.");
      }
      return output;
    },
  };
}

function validScheduleExtractedData() {
  return {
    document_title: "Termininfo",
    language: "de",
    course: { title: "Fachlabor", url: "https://moodle.example/my" },
    sources: [
      {
        id: "moodle_1",
        title: "Moodle announcement",
        kind: "moodle_page",
        url: "https://moodle.example/my",
        path: null,
        page: null,
      },
      {
        id: "cis_1",
        title: "CIS timetable",
        kind: "cis_page",
        url: "https://cis.example/cis.php",
        path: null,
        page: null,
      },
    ],
    sections: [
      {
        heading: "Morgen",
        summary: "Moodle und CIS wurden gemeinsam ausgewertet.",
        key_concepts: ["Fachlabor", "Raum"],
        source_ids: ["moodle_1", "cis_1"],
      },
    ],
    formulas: [],
    worked_examples: [],
    quiz_style_questions: [],
    warnings: [],
  };
}

function testConfig(runDir: string): MoodleRuntimeConfig {
  return {
    prompt: "test",
    moodleUrl: "https://moodle.example/course",
    outputPath: path.join(runDir, "document.typ"),
    runDir,
    maxDepth: 0,
    maxPages: 1,
    maxCisPages: 1,
    allowFileDownloads: false,
    baseUrl: "https://moodle.example",
    dashboardUrl: "https://moodle.example/my",
    username: "secret-user",
    password: "secret-pass",
    storageState: "/tmp/moodle-state.json",
    cisUrls: [],
    calendarUrl: "https://calendar.example/private-calendar-token",
    cisBaseUrl: "https://cis.example",
    cisDashboardUrl: "https://cis.example",
    cisUsername: "secret-user",
    cisPassword: "secret-pass",
    cisStorageState: "/tmp/cis-state.json",
    headless: true,
  };
}
