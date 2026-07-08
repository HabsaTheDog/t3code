import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";
import { compileTypstPdf, ensureInside } from "../validation.ts";
import {
  STUDY_BUDDY_TEMPLATE_FILE,
  STUDY_BUDDY_TYPST_TEMPLATE,
  typstPdfPath,
} from "../typstTemplate.ts";

export function createDiskWriterNode(config: MoodleRuntimeConfig) {
  return async function diskWriterNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    if (!state.final_document.trim()) {
      return {
        error_log: "Disk writer failed: final_document is empty.",
      };
    }
    const outputPath = ensureInside(config.runDir, config.outputPath);
    const templatePath = ensureInside(
      config.runDir,
      path.join(config.runDir, STUDY_BUDDY_TEMPLATE_FILE),
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(templatePath, STUDY_BUDDY_TYPST_TEMPLATE, "utf8");
    await writeFile(outputPath, state.final_document, "utf8");

    const pdfPath = ensureInside(config.runDir, typstPdfPath(outputPath));
    const compileResult = await compileTypstPdf(outputPath, pdfPath);
    if (!compileResult.ok) {
      return {
        error_log: `PDF compile failed: ${compileResult.error}`,
      };
    }

    return { error_log: null };
  };
}
