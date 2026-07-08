import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig, loadEnvFiles } from "../config.ts";

let tempDir: string | null = null;
let createdRunDir: string | null = null;
const originalEnv = {
  MOODLE_USERNAME: process.env.MOODLE_USERNAME,
  MOODLE_PASSWORD: process.env.MOODLE_PASSWORD,
  CIS_URLS: process.env.CIS_URLS,
  CIS_CALENDAR_URL: process.env.CIS_CALENDAR_URL,
  STUDY_BUDDY_WORKSPACE: process.env.STUDY_BUDDY_WORKSPACE,
  STUDY_BUDDY_CODEX_MODEL: process.env.STUDY_BUDDY_CODEX_MODEL,
  MOODLE_QUIZ_ALLOW_ATTEMPT: process.env.MOODLE_QUIZ_ALLOW_ATTEMPT,
  MOODLE_QUIZ_ACCESS_MODE: process.env.MOODLE_QUIZ_ACCESS_MODE,
  MOODLE_QUIZ_ALLOW_FILL_ANSWERS: process.env.MOODLE_QUIZ_ALLOW_FILL_ANSWERS,
  MOODLE_QUIZ_MIN_TIME_LIMIT_MINUTES: process.env.MOODLE_QUIZ_MIN_TIME_LIMIT_MINUTES,
  MOODLE_QUIZ_MIN_ATTEMPTS_LEFT: process.env.MOODLE_QUIZ_MIN_ATTEMPTS_LEFT,
  MOODLE_QUIZ_FILL_CONFIDENCE_THRESHOLD: process.env.MOODLE_QUIZ_FILL_CONFIDENCE_THRESHOLD,
  MOODLE_QUIZ_BLOCK_FINAL_SUBMIT: process.env.MOODLE_QUIZ_BLOCK_FINAL_SUBMIT,
};
afterEach(async () => {
  restoreEnv();
  if (createdRunDir) {
    await rm(createdRunDir, { recursive: true, force: true });
    createdRunDir = null;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("moodle config env loading", () => {
  it("loads later env files without overriding existing values", async () => {
    delete process.env.MOODLE_USERNAME;
    delete process.env.MOODLE_PASSWORD;
    delete process.env.CIS_URLS;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-config-"));
    const serverEnv = path.join(tempDir, "server.env");
    const rootEnv = path.join(tempDir, "root.env");
    await writeFile(
      serverEnv,
      "MOODLE_USERNAME=server-user\nCIS_URLS=https://server.example/cis\n",
      "utf8",
    );
    await writeFile(rootEnv, "MOODLE_USERNAME=root-user\nMOODLE_PASSWORD=root-pass\n", "utf8");

    loadEnvFiles([serverEnv, rootEnv]);

    expect(process.env.MOODLE_USERNAME).toBe("server-user");
    expect(process.env.MOODLE_PASSWORD).toBe("root-pass");
    expect(process.env.CIS_URLS).toBe("https://server.example/cis");
  });
});

describe("moodle output paths", () => {
  it("reads the private calendar URL from local environment configuration", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;
    process.env.CIS_CALENDAR_URL = "webcal://calendar.example/private-token";

    const config = createRuntimeConfig({
      prompt: "Wann ist die MEL1 Prüfung?",
      moodleUrl: "https://moodle.technikum-wien.at/my/",
    });
    createdRunDir = config.runDir;

    expect(config.calendarUrl).toBe("webcal://calendar.example/private-token");
  });

  it("writes default runs to the selected workspace", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;

    const config = createRuntimeConfig({
      prompt: "Generate notes",
      moodleUrl: "https://moodle.technikum-wien.at/course/view.php?id=1",
    });
    createdRunDir = config.runDir;

    expect(path.dirname(config.runDir)).toBe(path.join(tempDir, "output", "generate-notes"));
    expect(config.outputPath).toBe(path.join(config.runDir, "document.typ"));
  });

  it("uses an explicit Codex model over the inherited Study Buddy model", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;
    process.env.STUDY_BUDDY_CODEX_MODEL = "gpt-env";

    const config = createRuntimeConfig({
      prompt: "Generate notes",
      moodleUrl: "https://moodle.technikum-wien.at/course/view.php?id=1",
      codexModel: "gpt-selected",
    });
    createdRunDir = config.runDir;

    expect(config.codexModel).toBe("gpt-selected");
  });

  it("resolves relative explicit output paths against the selected workspace", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;

    const config = createRuntimeConfig({
      prompt: "Generate notes",
      moodleUrl: "https://moodle.technikum-wien.at/course/view.php?id=1",
      outputPath: "output/custom/document.typ",
    });
    createdRunDir = config.runDir;

    expect(config.outputPath).toBe(path.join(tempDir, "output/custom/document.typ"));
  });

  it("parses quiz safety policy values conservatively", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;
    process.env.MOODLE_QUIZ_ALLOW_ATTEMPT = "true";
    process.env.MOODLE_QUIZ_ACCESS_MODE = "quiz-assist";
    process.env.MOODLE_QUIZ_ALLOW_FILL_ANSWERS = "true";
    process.env.MOODLE_QUIZ_MIN_TIME_LIMIT_MINUTES = "20";
    process.env.MOODLE_QUIZ_MIN_ATTEMPTS_LEFT = "3";
    process.env.MOODLE_QUIZ_FILL_CONFIDENCE_THRESHOLD = "0.9";
    process.env.MOODLE_QUIZ_BLOCK_FINAL_SUBMIT = "false";

    const config = createRuntimeConfig({
      prompt: "Generate notes",
      moodleUrl: "https://moodle.technikum-wien.at/course/view.php?id=1",
    });
    createdRunDir = config.runDir;
    const policy = config.quizSafetyPolicy;

    expect(policy).toBeDefined();
    expect(policy?.accessMode).toBe("quiz-assist");
    expect(policy?.allowStartingOrContinuingAttempts).toBe(true);
    expect(policy?.allowFillingAnswers).toBe(true);
    expect(policy?.minimumTimeLimitMinutes).toBe(20);
    expect(policy?.minimumAttemptsLeft).toBe(3);
    expect(policy?.fillConfidenceThreshold).toBe(0.9);
    expect(policy?.finalSubmissionBlocked).toBe(true);
  });

  it("uses deterministic quiz access modes over low-level booleans", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-workspace-"));
    process.env.STUDY_BUDDY_WORKSPACE = tempDir;
    process.env.MOODLE_QUIZ_ACCESS_MODE = "info-only";
    process.env.MOODLE_QUIZ_ALLOW_READ_QUESTIONS = "true";
    process.env.MOODLE_QUIZ_ALLOW_FILL_ANSWERS = "true";

    const config = createRuntimeConfig({
      prompt: "Generate notes",
      moodleUrl: "https://moodle.technikum-wien.at/course/view.php?id=1",
    });
    createdRunDir = config.runDir;

    expect(config.quizSafetyPolicy?.accessMode).toBe("review-only");
    expect(config.quizSafetyPolicy?.allowReadingQuestions).toBe(true);
    expect(config.quizSafetyPolicy?.allowFillingAnswers).toBe(false);
  });
});

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
