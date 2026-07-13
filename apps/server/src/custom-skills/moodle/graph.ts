import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { END, START, StateGraph } from "@langchain/langgraph";
import {
  createAgentBrowserClient,
  type AgentBrowserClient,
  verifyAgentBrowserPolicy,
} from "./agentBrowserClient.ts";
import { createBrowserClient } from "./browserClient.ts";
import { createCodexClient, type CodexClient } from "./codexClient.ts";
import {
  AgentStateAnnotation,
  initialAgentState,
  type AgentState,
  type LangGraphAgentState,
} from "./state.ts";
import type { MoodleGraphInput, MoodleGraphResult, MoodleRuntimeConfig } from "./types.ts";
import { createRuntimeConfig } from "./config.ts";
import { extractedDataJsonSchema } from "./schemas.ts";
import { createAnalyzerNode } from "./nodes/analyzerNode.ts";
import { createCisScraperNode } from "./nodes/cisScraperNode.ts";
import { createCalendarNode } from "./nodes/calendarNode.ts";
import { createCalendarAnswerNode } from "./nodes/calendarAnswerNode.ts";
import { createDiskWriterNode } from "./nodes/diskWriterNode.ts";
import { createFormatterNode } from "./nodes/formatterNode.ts";
import {
  createQuizFillNode,
  createQuizPageNode,
  createQuizSolverNode,
  createQuizTargetNode,
  isQuizWorkflowDone,
} from "./nodes/quizWorkflowNodes.ts";
import { createScraperNode } from "./nodes/scraperNode.ts";
import { isQuizPrompt } from "./quizIntent.ts";
import { typstPdfPath } from "./typstTemplate.ts";
import {
  isCalendarRequest,
  isPureScheduleRequest,
  requiresCisDirectly,
} from "./calendarAdapter.ts";
import { redactSensitiveValues } from "./browserSecurity.ts";

const MAX_RETRIES = 3;

export interface GraphDependencies {
  codex?: CodexClient;
  scraperNode?: ReturnType<typeof createScraperNode>;
  cisScraperNode?: ReturnType<typeof createCisScraperNode>;
  calendarNode?: ReturnType<typeof createCalendarNode>;
  quizTargetNode?: ReturnType<typeof createQuizTargetNode>;
  quizPageNode?: ReturnType<typeof createQuizPageNode>;
  quizSolverNode?: ReturnType<typeof createQuizSolverNode>;
  quizFillNode?: ReturnType<typeof createQuizFillNode>;
  quizBrowser?: AgentBrowserClient;
}

export async function runMoodleGraph(
  input: MoodleGraphInput,
  dependencies: GraphDependencies = {},
): Promise<MoodleGraphResult> {
  const config = createRuntimeConfig(input);
  if (
    config.browserBackend === "agent-browser" &&
    !(config.calendarUrl && isPureScheduleRequest(config.prompt))
  ) {
    await runAgentBrowserPreflight(config);
  }
  const quizBrowser = isQuizPrompt(config.prompt)
    ? (dependencies.quizBrowser ?? createBrowserClient(config))
    : undefined;
  const graph = buildMoodleGraph(config, { ...dependencies, quizBrowser });
  let state: AgentState = initialAgentState;
  try {
    state = (await graph.invoke(initialAgentState)) as AgentState;
  } catch (error) {
    state = {
      ...state,
      error_log: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (quizBrowser && !config.keepBrowserOpen) {
      await quizBrowser.close().catch(() => undefined);
    }
  }

  state = sanitizeGraphState(state, config);

  const ok = !state.error_log && Boolean(state.final_document.trim());
  const calendarOnlyAnswer = Boolean(
    config.calendarSelection?.complete && isPureScheduleRequest(config.prompt),
  );
  const coverageComplete = isCoverageComplete(config, state);
  await persistRunDiagnostics(config, state);
  const pdfPath = ok && !calendarOnlyAnswer ? await existingPdfPath(config.outputPath) : undefined;
  const answerPath = calendarOnlyAnswer
    ? await existingArtifactPath(path.join(config.runDir, "answer.md"))
    : undefined;
  const answerJsonPath = calendarOnlyAnswer
    ? await existingArtifactPath(path.join(config.runDir, "answer.json"))
    : undefined;
  const result: MoodleGraphResult = {
    ok,
    coverageComplete,
    state,
    sourceCoverage: state.source_coverage,
  };
  if (ok && !calendarOnlyAnswer) {
    result.outputPath = config.outputPath;
  }
  if (pdfPath) {
    result.pdfPath = pdfPath;
  }
  if (answerPath) result.answerPath = answerPath;
  if (answerJsonPath) result.answerJsonPath = answerJsonPath;
  if (state.error_log) {
    result.error = state.error_log;
  }
  return {
    ...result,
  };
}

export function sanitizeGraphState(state: AgentState, config: MoodleRuntimeConfig): AgentState {
  const sensitiveValues = [
    config.username,
    config.password,
    config.cisUsername,
    config.cisPassword,
    config.calendarUrl,
  ];
  const sanitizeJson = <T>(value: T): T =>
    JSON.parse(redactSensitiveValues(JSON.stringify(value), sensitiveValues)) as T;
  return {
    ...state,
    moodle_raw_text: redactSensitiveValues(state.moodle_raw_text, sensitiveValues),
    extracted_data: sanitizeJson(state.extracted_data),
    final_document: redactSensitiveValues(state.final_document, sensitiveValues),
    error_log: state.error_log
      ? redactSensitiveValues(state.error_log, sensitiveValues)
      : state.error_log,
    source_coverage: sanitizeJson(state.source_coverage),
  };
}

async function existingPdfPath(outputPath: string): Promise<string | undefined> {
  const pdfPath = typstPdfPath(outputPath);
  try {
    await access(pdfPath);
    return pdfPath;
  } catch {
    return undefined;
  }
}

async function existingArtifactPath(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath);
    return filePath;
  } catch {
    return undefined;
  }
}

async function runAgentBrowserPreflight(config: MoodleRuntimeConfig): Promise<void> {
  try {
    await verifyAgentBrowserPolicy(config);
    await createAgentBrowserClient(config).doctor();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent-browser preflight failed; continuing anyway:\n${message}`);
  }
}

export function buildMoodleGraph(
  config: MoodleRuntimeConfig,
  dependencies: GraphDependencies = {},
) {
  const codex = dependencies.codex ?? createCodexClient(config);
  const scraperNode = dependencies.scraperNode ?? createScraperNode(config);
  const cisScraperNode = dependencies.cisScraperNode ?? createCisScraperNode(config);
  const calendarNode = dependencies.calendarNode ?? createCalendarNode(config);
  const analyzerNode = createAnalyzerNode(config, codex);
  const formatterNode = createFormatterNode(config, codex);
  const diskWriterNode = createDiskWriterNode(config);
  const quizBrowser = dependencies.quizBrowser ?? createBrowserClient(config);

  return new StateGraph(AgentStateAnnotation)
    .addNode("scraper", scraperNode)
    .addNode("calendar", calendarNode)
    .addNode("calendarAnswer", createCalendarAnswerNode(config))
    .addNode("router", async () => ({}))
    .addNode(
      "quizTarget",
      dependencies.quizTargetNode ?? createQuizTargetNode(config, { agentBrowser: quizBrowser }),
    )
    .addNode(
      "quizPage",
      dependencies.quizPageNode ?? createQuizPageNode(config, { agentBrowser: quizBrowser }),
    )
    .addNode("quizSolver", dependencies.quizSolverNode ?? createQuizSolverNode(config, { codex }))
    .addNode(
      "quizFill",
      dependencies.quizFillNode ?? createQuizFillNode(config, { agentBrowser: quizBrowser }),
    )
    .addNode("cisScraper", cisScraperNode)
    .addNode("analyzer", analyzerNode)
    .addNode("formatter", formatterNode)
    .addNode("diskWriter", diskWriterNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", () => routeInitial(config), {
      quizTarget: "quizTarget",
      calendar: "calendar",
      cisScraper: "cisScraper",
      scraper: "scraper",
    })
    .addConditionalEdges("calendar", () => routeAfterCalendar(config), {
      calendarAnswer: "calendarAnswer",
      cisScraper: "cisScraper",
      scraper: "scraper",
    })
    .addEdge("calendarAnswer", END)
    .addConditionalEdges("quizTarget", routeAfterQuizTarget, {
      quizPage: "quizPage",
      diskWriter: "diskWriter",
    })
    .addEdge("quizPage", "quizSolver")
    .addEdge("quizSolver", "quizFill")
    .addConditionalEdges("quizFill", routeAfterQuizFill, {
      quizPage: "quizPage",
      diskWriter: "diskWriter",
    })
    .addConditionalEdges("scraper", () => routeAfterScraper(config), {
      cisScraper: "cisScraper",
      analyzer: "analyzer",
    })
    .addEdge("cisScraper", "analyzer")
    .addConditionalEdges("analyzer", routeAfterAnalyzer, {
      analyzer: "analyzer",
      formatter: "formatter",
      abort: END,
    })
    .addConditionalEdges("formatter", routeAfterFormatter, {
      formatter: "formatter",
      diskWriter: "diskWriter",
      abort: END,
    })
    .addEdge("diskWriter", END)
    .compile();
}

function routeInitial(
  config: MoodleRuntimeConfig,
): "quizTarget" | "calendar" | "cisScraper" | "scraper" {
  if (
    isQuizPrompt(config.prompt) &&
    (/\b(?:bearbeite|mach|starte|fülle|fuelle|ausfüllen|ausfuellen|solve|fill|answer)\b/i.test(
      config.prompt,
    ) ||
      !/\b(?:wann|wo|termin|uhrzeit|raum|schedule|date|time)\b/i.test(config.prompt))
  ) {
    return "quizTarget";
  }
  if (requiresCisDirectly(config.prompt)) return "cisScraper";
  if (
    config.calendarUrl &&
    isCalendarRequest(config.prompt) &&
    !requiresCisDirectly(config.prompt)
  ) {
    return "calendar";
  }
  return isPureScheduleRequest(config.prompt) ? "cisScraper" : "scraper";
}

function routeAfterCalendar(
  config: MoodleRuntimeConfig,
): "calendarAnswer" | "cisScraper" | "scraper" {
  if (config.calendarSelection?.complete && isPureScheduleRequest(config.prompt)) {
    return "calendarAnswer";
  }
  return isPureScheduleRequest(config.prompt) ? "cisScraper" : "scraper";
}

function routeAfterScraper(config: MoodleRuntimeConfig): "cisScraper" | "analyzer" {
  if (config.calendarSelection?.complete && !requiresCisDirectly(config.prompt)) {
    return "analyzer";
  }
  return "cisScraper";
}

function routeAfterQuizTarget(state: LangGraphAgentState): "quizPage" | "diskWriter" {
  return isQuizWorkflowDone(state) ? "diskWriter" : "quizPage";
}

function routeAfterQuizFill(state: LangGraphAgentState): "quizPage" | "diskWriter" {
  return isQuizWorkflowDone(state) ? "diskWriter" : "quizPage";
}

function routeAfterAnalyzer(state: LangGraphAgentState): "analyzer" | "formatter" | "abort" {
  if (!state.error_log) {
    return "formatter";
  }
  return state.retry_count >= MAX_RETRIES ? "abort" : "analyzer";
}

function routeAfterFormatter(state: LangGraphAgentState): "formatter" | "diskWriter" | "abort" {
  if (!state.error_log) {
    return "diskWriter";
  }
  return state.retry_count >= MAX_RETRIES ? "abort" : "formatter";
}

function isCoverageComplete(config: MoodleRuntimeConfig, state: AgentState): boolean {
  const scheduleRequest = isCalendarRequest(config.prompt);
  const pureSchedule = isPureScheduleRequest(config.prompt);
  const moodleOk = pureSchedule || state.source_coverage.moodle.status === "success";
  const scheduleOk =
    !scheduleRequest ||
    (state.source_coverage.calendar.status === "success" &&
      config.calendarSelection?.complete === true) ||
    state.source_coverage.cis.status === "success";
  return moodleOk && scheduleOk;
}

export async function persistRunDiagnostics(
  config: MoodleRuntimeConfig,
  state: AgentState,
): Promise<void> {
  await mkdir(config.runDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(config.runDir, "config.json"), sanitizeConfig(config)),
    writeFile(path.join(config.runDir, "moodle_raw.txt"), state.moodle_raw_text, "utf8"),
    writeJson(path.join(config.runDir, "state.json"), {
      ...state,
      moodle_raw_text: state.moodle_raw_text ? "[see moodle_raw.txt]" : "",
      final_document: state.final_document
        ? config.calendarSelection?.complete && isPureScheduleRequest(config.prompt)
          ? "[see answer.md]"
          : "[see document.typ]"
        : "",
    }),
    writeJson(path.join(config.runDir, "source_coverage.json"), state.source_coverage),
    writeFile(path.join(config.runDir, "error.log"), state.error_log ?? "", "utf8"),
    writeJson(path.join(config.runDir, "schema.json"), extractedDataJsonSchema),
  ]);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeConfig(config: MoodleRuntimeConfig) {
  return {
    prompt: config.prompt,
    moodleUrl: config.moodleUrl,
    outputPath: config.outputPath,
    runDir: config.runDir,
    maxDepth: config.maxDepth,
    maxPages: config.maxPages,
    maxCisPages: config.maxCisPages,
    allowFileDownloads: config.allowFileDownloads,
    baseUrl: config.baseUrl,
    dashboardUrl: config.dashboardUrl,
    hasUsername: Boolean(config.username),
    hasPassword: Boolean(config.password),
    hasStorageState: Boolean(config.storageState),
    cisUrls: config.cisUrls,
    cisBaseUrl: config.cisBaseUrl,
    cisDashboardUrl: config.cisDashboardUrl,
    hasCisUsername: Boolean(config.cisUsername),
    hasCisPassword: Boolean(config.cisPassword),
    hasCisStorageState: Boolean(config.cisStorageState),
    hasCalendarUrl: Boolean(config.calendarUrl),
    headless: config.headless,
    browserBackend: config.browserBackend,
    cisBrowserBackend: config.cisBrowserBackend,
    browserSession: config.browserSession,
    browserSessionName: config.browserSessionName,
    browserAllowedDomains: config.browserAllowedDomains,
    browserActionPolicyPath: config.browserActionPolicyPath,
    browserMaxOutput: config.browserMaxOutput,
    keepBrowserOpen: config.keepBrowserOpen,
    codexModel: config.codexModel,
  };
}
