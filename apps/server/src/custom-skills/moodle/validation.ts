import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { ExtractedDataSchema, type ExtractedData } from "./schemas.ts";
import type { JsonArray, JsonObject, JsonValue } from "./state.ts";

export function parseJsonObjectOrArray(text: string): JsonObject | JsonArray {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const jsonText = fenced?.[1] ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as JsonValue;
    if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
      return {
        raw_text: jsonText,
        warnings: ["Expected a JSON object or array; preserving raw response."],
      };
    }
    return parsed as JsonObject | JsonArray;
  } catch (error) {
    return {
      raw_text: trimmed,
      warnings: [
        `JSON parsing failed; preserving raw response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

export function validateExtractedData(value: unknown): ExtractedData {
  const result = ExtractedDataSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const rawText = extractRawText(value);
  return {
    document_title: "Moodle output",
    language: "de",
    course: {
      title: "n/a",
      url: "",
    },
    sources: [],
    sections: rawText
      ? [
          {
            heading: "Raw response",
            summary: rawText,
            key_concepts: [],
            source_ids: [],
          },
        ]
      : [],
    formulas: [],
    worked_examples: [],
    quiz_style_questions: [],
    warnings: [
      "Structured validation failed; continuing with preserved raw output.",
      result.error.message,
    ],
  };
}

export async function validateTypst(
  source: string,
  supportFiles: TypstSupportFile[] = [],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const typstPath = await findExecutable("typst");
  if (!typstPath) {
    return { ok: true };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-typst-"));
  const sourcePath = path.join(tempDir, "document.typ");
  const targetPath = path.join(tempDir, "document.pdf");
  await writeFile(sourcePath, source, "utf8");
  await writeTypstSupportFiles(tempDir, supportFiles);

  try {
    const result = await compileWithTypst(typstPath, sourcePath, targetPath);
    if (result.code === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      error: result.stderr || result.stdout || `typst exited with code ${result.code}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export interface TypstSupportFile {
  relativePath: string;
  content: string;
}

export type TypstCompileResult =
  | { ok: true; skipped: false }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

export async function compileTypstPdf(
  sourcePath: string,
  targetPath: string,
): Promise<TypstCompileResult> {
  const typstPath = await findExecutable("typst");
  if (!typstPath) {
    return { ok: true, skipped: true, reason: "typst executable was not found on PATH." };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const result = await compileWithTypst(typstPath, sourcePath, targetPath);
  if (result.code === 0) {
    return { ok: true, skipped: false };
  }
  return {
    ok: false,
    error: result.stderr || result.stdout || `typst exited with code ${result.code}`,
  };
}

function extractRawText(value: unknown): string {
  if (typeof value === "object" && value !== null && "raw_text" in value) {
    const rawText = (value as { raw_text?: unknown }).raw_text;
    if (typeof rawText === "string") {
      return rawText.slice(0, 20_000);
    }
  }
  try {
    return JSON.stringify(value, null, 2).slice(0, 20_000);
  } catch {
    return String(value).slice(0, 20_000);
  }
}

async function writeTypstSupportFiles(baseDir: string, supportFiles: TypstSupportFile[]) {
  for (const file of supportFiles) {
    const supportPath = ensureInside(baseDir, path.join(baseDir, file.relativePath));
    await mkdir(path.dirname(supportPath), { recursive: true });
    await writeFile(supportPath, file.content, "utf8");
  }
}

export function ensureInside(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside run directory: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

async function findExecutable(name: string): Promise<string | null> {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function compileWithTypst(
  typstPath: string,
  sourcePath: string,
  targetPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCommand(typstPath, ["compile", sourcePath, targetPath]);
}
