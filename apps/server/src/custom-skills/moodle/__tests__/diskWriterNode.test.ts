import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiskWriterNode } from "../nodes/diskWriterNode.ts";
import { initialSourceCoverage } from "../state.ts";
import { STUDY_BUDDY_TEMPLATE_FILE, typstPdfPath } from "../typstTemplate.ts";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("diskWriterNode", () => {
  it("writes final Typst inside the run directory", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-run-"));
    const outputPath = path.join(runDir, "document.typ");
    const node = createDiskWriterNode({
      prompt: "test",
      moodleUrl: "https://moodle.example",
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
    });

    await node({
      moodle_raw_text: "",
      source_coverage: initialSourceCoverage,
      extracted_data: {},
      final_document: "#set page()\n",
      error_log: null,
      retry_count: 0,
    });

    await expect(readFile(outputPath, "utf8")).resolves.toBe("#set page()\n");
    await expect(readFile(path.join(runDir, STUDY_BUDDY_TEMPLATE_FILE), "utf8")).resolves.toContain(
      "sb-document",
    );
    if (await fileExists(typstPdfPath(outputPath))) {
      await expect(readFile(typstPdfPath(outputPath))).resolves.toBeInstanceOf(Buffer);
    }
  });

  it("refuses to write outside the run directory", async () => {
    runDir = await mkdtemp(path.join(os.tmpdir(), "moodle-run-"));
    const node = createDiskWriterNode({
      prompt: "test",
      moodleUrl: "https://moodle.example",
      outputPath: path.join(runDir, "..", "escape.typ"),
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
    });

    await expect(
      node({
        moodle_raw_text: "",
        source_coverage: initialSourceCoverage,
        extracted_data: {},
        final_document: "#set page()\n",
        error_log: null,
        retry_count: 0,
      }),
    ).rejects.toThrow(/outside run directory/);
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}
