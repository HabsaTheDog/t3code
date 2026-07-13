import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBrowserClient } from "../agentBrowserClient.ts";
import { createBrowserClient } from "../browserClient.ts";
import { createBrowserLoginConfig, ensureAgentBrowserLoggedIn } from "../browserAuth.ts";
import {
  extractLinksFromSnapshot,
  isFinalSubmitClickLabel,
  safeFileName,
} from "../browserSafety.ts";
import type { CodexClient } from "../codexClient.ts";
import { extractQuizUrl, promptWantsQuizAttempt } from "../quizIntent.ts";
import {
  enforceQuizSafetyPolicy,
  extractQuizMetadata,
  type QuizMetadata,
  type QuizPolicyDecision,
} from "../quizSafetyPolicy.ts";
import type { JsonObject, LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

export interface QuizQuestion {
  question_id: string;
  question_index: number;
  question_type: string;
  prompt: string;
  prompt_latex?: string;
  prompt_html?: string;
  options: string[];
  controls: Array<Record<string, unknown>>;
  visible_context: string;
}

export interface QuizPageExtraction {
  title: string;
  url: string;
  body_text: string;
  questions: QuizQuestion[];
}

export interface QuizCandidate {
  title: string;
  url: string;
  sourceUrl: string;
  score: number;
}

export interface AnswerSpec {
  question_id?: string;
  question_index?: number;
  answer?: unknown;
  answers?: unknown[];
  confidence?: number;
  citations?: string[];
  rationale?: string;
  risk_flags?: string[];
}

export interface QuizReviewNodeDependencies {
  agentBrowser?: AgentBrowserClient;
  codex?: CodexClient;
}

const QUESTION_EXTRACTION_JS = String.raw`
(() => {
  const normalize = value => (value || "").replace(/\s+/g, " ").trim();
  const textOf = node => node ? (node.innerText || node.textContent || "") : "";
  const htmlOf = node => node ? (node.innerHTML || "") : "";
  const mathText = node => {
    if (!node) return "";
    const bits = [];
    for (const math of node.querySelectorAll("mjx-container, math, .MathJax, .MathJax_Display, script[type^='math/tex']")) {
      bits.push(
        math.getAttribute("aria-label") ||
        math.getAttribute("data-semantic-speech") ||
        math.getAttribute("alttext") ||
        math.textContent ||
        ""
      );
    }
    for (const img of node.querySelectorAll("img[alt], img[title]")) {
      bits.push(img.getAttribute("alt") || img.getAttribute("title") || "");
    }
    return normalize(bits.join(" "));
  };
  const optionLetter = text => {
    const match = normalize(text).match(/^([a-z])\s*[.)]/i);
    return match ? match[1].toLowerCase() : null;
  };
  const questionNodes = [...document.querySelectorAll(".que, [id^='question-']")];
  const questions = questionNodes.map((node, index) => {
    const promptNode = node.querySelector(".qtext") || node;
    const visibleText = textOf(node).trim();
    const numberMatch = visibleText.match(/(?:Frage|Question)\s+(\d+)/i);
    const questionNumber = numberMatch ? Number(numberMatch[1]) : index + 1;
    const controls = [...node.querySelectorAll("input, textarea, select")]
      .filter(el => !["hidden", "submit", "button"].includes((el.type || "").toLowerCase()))
      .map(el => {
        const labels = [...(el.labels || [])].map(label => textOf(label).trim()).filter(Boolean);
        const optionContainer = el.closest("label, .r0, .r1, .answer div, p, li");
        const optionText = labels[0] || textOf(optionContainer).trim();
        const optionHtml = htmlOf(optionContainer);
        const optionMath = mathText(optionContainer || el);
        return {
          tag: el.tagName.toLowerCase(),
          type: (el.type || el.tagName).toLowerCase(),
          id: el.id || null,
          name: el.name || null,
          value: el.value || "",
          checked: Boolean(el.checked),
          disabled: Boolean(el.disabled),
          option_text: optionText,
          letter: optionLetter(optionText),
          latex: optionMath,
          raw_html: optionHtml
        };
      });
    const options = controls
      .filter(control => ["radio", "checkbox"].includes(control.type))
      .map(control => control.option_text)
      .filter(Boolean);
    return {
      question_id: node.id || "question-" + (index + 1),
      question_index: questionNumber,
      question_type: [...node.classList].find(c => c !== "que") || "unknown",
      prompt: textOf(promptNode).trim(),
      prompt_latex: mathText(promptNode),
      prompt_html: htmlOf(promptNode),
      options: [...new Set(options)].slice(0, 20),
      controls,
      visible_context: visibleText
    };
  });
  return JSON.stringify({
    title: document.title,
    url: location.href,
    body_text: textOf(document.body),
    questions
  });
})()
`;

const SUBAGENT_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question_id: { type: ["string", "null"] },
    question_index: { type: ["number", "null"] },
    answer: { type: "string" },
    answers: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    citations: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    risk_flags: { type: "array", items: { type: "string" } },
  },
  required: [
    "question_id",
    "question_index",
    "answer",
    "answers",
    "confidence",
    "citations",
    "rationale",
    "risk_flags",
  ],
} as const;

export function createQuizReviewNode(
  config: MoodleRuntimeConfig,
  dependencies: QuizReviewNodeDependencies = {},
) {
  return async function quizReviewNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    const client = dependencies.agentBrowser ?? createBrowserClient(config);
    try {
      await ensureAgentBrowserLoggedIn(
        client,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: config.moodleUrl || config.dashboardUrl,
          username: config.username,
          password: config.password,
          allowedOrigins: config.moodleLoginAllowedOrigins,
        }),
      );

      const target = extractQuizUrl(config.prompt) ?? (await discoverQuizTarget(config, client));
      if (!target) {
        const report = buildNoQuizReport(config.prompt);
        await persistQuizArtifacts(config, {
          report,
          questions: [],
          candidates: [],
          targetUrl: null,
          finalSubmitClicked: false,
        });
        return {
          final_document: report,
          extracted_data: toJsonObject({
            kind: "quiz_review",
            status: "no_quiz_target",
            questions: [],
          }),
          source_coverage: {
            ...state.source_coverage,
            moodle: {
              status: "empty",
              detail: "No Moodle quiz target was found for the prompt.",
              urls: [config.moodleUrl],
              pages: 1,
            },
          },
          error_log: null,
        };
      }

      const openDecision = enforceQuizSafetyPolicy(config.quizSafetyPolicy, "open_quiz_page");
      if (openDecision.status !== "allowed") {
        return await stopForQuizPolicy(config, state, target, openDecision);
      }

      await client.open(target);
      await client.wait(1_000);
      const metadata = await extractQuizMetadata(client);
      const readDecision = enforceQuizSafetyPolicy(config.quizSafetyPolicy, "read_questions");
      if (readDecision.status !== "allowed") {
        return await stopForQuizPolicy(config, state, target, readDecision, metadata);
      }

      const wantsAttempt = promptWantsQuizAttempt(config.prompt);
      let beforeStart = await extractQuizPage(client);
      if (beforeStart.questions.length === 0) {
        const reviewResult = await openSafePreviousAttemptReview(client);
        if (reviewResult.clicked) {
          await client.wait(1_500);
          beforeStart = await extractQuizPage(client);
        }
      }
      const startDecision = wantsAttempt
        ? enforceQuizSafetyPolicy(config.quizSafetyPolicy, "start_or_continue_attempt", {
            metadata,
          })
        : null;
      if (
        startDecision?.status &&
        startDecision.status !== "allowed" &&
        beforeStart.questions.length === 0
      ) {
        return await stopForQuizPolicy(config, state, target, startDecision, metadata);
      }
      const startResult =
        wantsAttempt && beforeStart.questions.length === 0
          ? await clickSafeStartOrContinue(client)
          : { clicked: false, reason: "not-requested-or-questions-visible" };
      if (startResult.clicked) {
        await client.wait(1_500);
      }
      const fillResults = config.autoAnswer
        ? await autoAnswerVisibleQuiz(config, client, dependencies.codex)
        : [];
      const page = await extractQuizPage(client);
      const risks = detectQuizRisks(page.body_text);
      const report = buildQuizReviewReport({
        page,
        target,
        startResult,
        metadata,
        risks,
        fillResults,
      });
      await persistQuizArtifacts(config, {
        report,
        questions: page.questions,
        candidates: [],
        targetUrl: page.url || target,
        finalSubmitClicked: false,
        startResult,
        metadata,
        risks,
        fillResults,
      });

      return {
        moodle_raw_text: formatQuizRawText(page),
        final_document: report,
        extracted_data: toJsonObject({
          kind: "quiz_review",
          status: page.questions.length ? "questions_visible" : "no_questions_visible",
          target_url: page.url || target,
          questions: page.questions,
          start_result: startResult,
          quiz_metadata: metadata,
          fill_results: fillResults,
          risks,
          final_submit_clicked: false,
        }),
        source_coverage: {
          ...state.source_coverage,
          moodle: {
            status: "success",
            detail: `Reviewed Moodle quiz with ${page.questions.length} visible question(s).`,
            urls: [page.url || target],
            pages: 1,
          },
        },
        error_log: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        final_document: `= Moodle Quiz Review\n\nFehler: ${message}\n\nFinal submit was not clicked.\n`,
        error_log: message,
      };
    } finally {
      if (!config.keepBrowserOpen) {
        await client.close().catch(() => undefined);
      }
    }
  };
}

export async function autoAnswerVisibleQuiz(
  config: MoodleRuntimeConfig,
  client: AgentBrowserClient,
  codex: CodexClient | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!codex) {
    return [{ action: "auto_answer", filled: false, reason: "codex-client-unavailable" }];
  }
  const allResults: Array<Record<string, unknown>> = [];
  const packetRoot = path.join(config.runDir, "subagent-packets");
  await mkdir(packetRoot, { recursive: true });

  for (let pageNumber = 1; pageNumber <= Math.max(1, config.maxPages); pageNumber += 1) {
    const readDecision = enforceQuizSafetyPolicy(config.quizSafetyPolicy, "read_questions");
    if (readDecision.status !== "allowed") {
      allResults.push(policyDecisionResult(readDecision, pageNumber));
      break;
    }
    const page = await extractQuizPage(client);
    if (!page.questions.length) {
      allResults.push({ page_number: pageNumber, action: "extract", questions: 0 });
      break;
    }
    const pageDir = path.join(packetRoot, `page-${String(pageNumber).padStart(3, "0")}`);
    await mkdir(pageDir, { recursive: true });
    const pageResults: Array<Record<string, unknown>> = [];

    for (const question of page.questions) {
      const packetPath = path.join(
        pageDir,
        `question-${String(question.question_index).padStart(3, "0")}.json`,
      );
      const packet = buildQuestionPacket({ page, question, pageNumber });
      await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
      const suggestionDecision = enforceQuizSafetyPolicy(
        config.quizSafetyPolicy,
        "suggest_answers",
      );
      if (suggestionDecision.status !== "allowed") {
        pageResults.push({
          ...policyDecisionResult(suggestionDecision, pageNumber),
          question_id: question.question_id,
          question_index: question.question_index,
        });
        continue;
      }
      const answer = await generateAnswerSpec(codex, packet);
      await writeFile(
        path.join(path.dirname(packetPath), "answer-spec.json"),
        `${JSON.stringify(answer, null, 2)}\n`,
        "utf8",
      );
      const result = await fillVisibleQuestion(client, question, answer, config.quizSafetyPolicy);
      pageResults.push({ ...result, page_number: pageNumber });
    }
    allResults.push(...pageResults);

    if (pageNumber >= Math.max(1, config.maxPages)) {
      allResults.push({
        page_number: pageNumber,
        action: "navigation",
        clicked: false,
        reason: "max-pages-reached",
      });
      break;
    }
    const nextDecision = enforceQuizSafetyPolicy(config.quizSafetyPolicy, "save_or_next_page");
    if (nextDecision.status !== "allowed") {
      allResults.push(policyDecisionResult(nextDecision, pageNumber));
      break;
    }
    const nextResult = await clickSafeNextPage(client);
    allResults.push({ page_number: pageNumber, action: "navigation", ...nextResult });
    if (!nextResult.clicked) {
      break;
    }
    await client.wait(1_000);
  }

  return allResults;
}

export function buildQuestionPacket(input: {
  page: QuizPageExtraction;
  question: QuizQuestion;
  pageNumber: number;
}): Record<string, unknown> {
  return {
    captured_at: new Date().toISOString(),
    page_number: input.pageNumber,
    title: input.page.title,
    url: input.page.url,
    question: input.question,
    page_body_excerpt: input.page.body_text.slice(0, 6000),
    instructions: [
      "Return only the answer JSON matching the schema.",
      "Use citations from the visible Moodle question/options or known course source text in this packet.",
      "If unsure, set confidence below 0.65 or add a risk flag so the orchestrator leaves the answer unchanged.",
    ],
  };
}

export async function generateAnswerSpec(
  codex: CodexClient,
  packet: Record<string, unknown>,
): Promise<AnswerSpec> {
  const prompt = [
    "Answer this Moodle quiz question for a study assistant.",
    "Return strict JSON with answer/answers, confidence, citations, rationale, and risk_flags.",
    "Do not invent unsupported answers. If insufficiently sourced, use confidence 0.",
    "",
    JSON.stringify(packet, null, 2),
  ].join("\n");
  const raw = await codex.run(prompt, { outputSchema: SUBAGENT_ANSWER_SCHEMA });
  return normalizeAnswerSpec(JSON.parse(stripJsonFence(raw)));
}

function normalizeAnswerSpec(value: unknown): AnswerSpec {
  const answer = (value && typeof value === "object" ? value : {}) as AnswerSpec;
  const normalized: AnswerSpec = {
    answer: answer.answer,
    answers: Array.isArray(answer.answers) ? answer.answers : [],
    confidence: Number(answer.confidence ?? 0),
    citations: Array.isArray(answer.citations) ? answer.citations.map(String) : [],
    rationale: String(answer.rationale ?? ""),
    risk_flags: Array.isArray(answer.risk_flags) ? answer.risk_flags.map(String) : [],
  };
  if (answer.question_id !== undefined && answer.question_id !== null) {
    normalized.question_id = answer.question_id;
  }
  if (answer.question_index !== undefined && answer.question_index !== null) {
    normalized.question_index = answer.question_index;
  }
  return normalized;
}

function stripJsonFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function fillVisibleQuestion(
  client: AgentBrowserClient,
  question: QuizQuestion,
  answer: AnswerSpec,
  policy?: MoodleRuntimeConfig["quizSafetyPolicy"],
): Promise<Record<string, unknown>> {
  if (policy) {
    const fillDecision = enforceQuizSafetyPolicy(policy, "fill_answers", { question, answer });
    if (fillDecision.status !== "allowed") {
      return {
        question_id: question.question_id,
        question_index: question.question_index,
        filled: false,
        answer,
        ...policyDecisionResult(fillDecision),
      };
    }
  }
  const validationError = validateAnswerSpec(answer, policy?.fillConfidenceThreshold ?? 0.65);
  if (validationError) {
    return {
      question_id: question.question_id,
      question_index: question.question_index,
      filled: false,
      reason: validationError,
      answer,
    };
  }
  const result = await client.evalJson<Record<string, unknown>>(
    buildFillQuestionJs(question, answer),
  );
  return {
    question_id: question.question_id,
    question_index: question.question_index,
    answer,
    ...result,
  };
}

function validateAnswerSpec(answer: AnswerSpec, confidenceThreshold: number): string | null {
  if (answer.answer === undefined && (!answer.answers || answer.answers.length === 0)) {
    return "answer-missing";
  }
  if (Number(answer.confidence ?? 0) < confidenceThreshold) {
    return "confidence-below-threshold";
  }
  if (!answer.citations?.length) {
    return "citations-missing";
  }
  if (answer.risk_flags?.length) {
    return "answer-risk-flags-present";
  }
  return null;
}

function answerValues(answer: AnswerSpec): unknown[] {
  if (answer.answers?.length) {
    return answer.answers;
  }
  return [answer.answer];
}

function buildFillQuestionJs(question: QuizQuestion, answer: AnswerSpec): string {
  return String.raw`
(() => {
  const question = document.getElementById(${JSON.stringify(question.question_id)});
  const answer = ${JSON.stringify(answerValues(answer))};
  if (!question) return JSON.stringify({ filled: false, reason: "question-not-found" });
  const rawValues = Array.isArray(answer) ? answer : [answer];
  const values = rawValues.map(value => typeof value === "object" && value !== null ? value : { text: String(value) });
  const normalize = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const compact = value => normalize(value).replace(/\s+/g, "");
  const letterOf = value => {
    const match = normalize(value).match(/^([a-z])\s*[.)]?/);
    return match ? match[1] : "";
  };
  const equivalent = (expectedRaw, optionRaw) => {
    const expected = normalize(expectedRaw);
    const option = normalize(optionRaw);
    return Boolean(expected && option && (option === expected || compact(option) === compact(expected)));
  };
  const textControls = [...question.querySelectorAll("input:not([type]), input[type='text'], input[type='number'], textarea")]
    .filter(el => !el.disabled && !el.readOnly && el.type !== "hidden");
  if (textControls.length) {
    const filledControls = [];
    textControls.forEach((control, index) => {
      const value = values[index] ?? values[values.length - 1] ?? { text: "" };
      control.focus();
      control.value = String(value.text ?? value.value ?? "");
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      filledControls.push({ id: control.id || null, name: control.name || null });
    });
    return JSON.stringify({ filled: true, reason: "filled-text", control: { count: filledControls.length, matched: filledControls } });
  }

  const choiceControls = [...question.querySelectorAll("input[type='radio'], input[type='checkbox']")].filter(el => !el.disabled);
  let changed = 0;
  const matchedControls = [];
  for (const expectedSpec of values) {
    const expected = normalize(String(expectedSpec.text ?? expectedSpec.answer ?? expectedSpec.value ?? ""));
    const expectedLetter = normalize(String(expectedSpec.letter ?? "")) || letterOf(expected);
    const expectedControlId = String(expectedSpec.control_id ?? expectedSpec.id ?? "");
    let matched = null;
    let matchedBy = null;
    for (const control of choiceControls) {
      const labels = [...(control.labels || [])].map(label => label.innerText).join(" ");
      const container = control.closest("label, .r0, .r1, .answer div, p, li");
      const optionText = normalize(labels || (container ? container.innerText : "") || control.value || "");
      const optionLetter = letterOf(optionText);
      if (expectedControlId && control.id === expectedControlId) {
        matched = control;
        matchedBy = "control_id";
        break;
      }
      if (expectedLetter && optionLetter && expectedLetter === optionLetter) {
        matched = control;
        matchedBy = "letter";
        break;
      }
      if (equivalent(expected, optionText) || equivalent(expected, control.value || "")) {
        matched = control;
        matchedBy = "text";
        break;
      }
    }
    if (matched) {
      matched.checked = true;
      matched.dispatchEvent(new Event("input", { bubbles: true }));
      matched.dispatchEvent(new Event("change", { bubbles: true }));
      changed += 1;
      matchedControls.push({ id: matched.id || null, name: matched.name || null, matched_by: matchedBy });
    }
  }
  if (changed) return JSON.stringify({ filled: true, reason: "filled-choice", control: { count: changed, matched: matchedControls } });

  const selects = [...question.querySelectorAll("select:not([disabled])")];
  for (const [index, select] of selects.entries()) {
    const value = values[index] ?? values[values.length - 1] ?? { text: "" };
    const expected = normalize(String(value.text ?? value.value ?? ""));
    const option = [...select.options].find(opt => equivalent(expected, opt.text || "") || normalize(opt.value || "") === expected);
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify({ filled: true, reason: "filled-select", control: { id: select.id || null, name: select.name || null } });
    }
  }
  return JSON.stringify({ filled: false, reason: "no-compatible-control-or-option-match" });
})()
`;
}

export async function clickSafeNextPage(
  client: AgentBrowserClient,
): Promise<{ clicked: boolean; text?: string; ref?: string; reason?: string }> {
  const snapshot = await client.snapshot({ interactive: true, compact: true });
  for (const line of snapshot.snapshot.split("\n")) {
    const ref = /ref=([a-z0-9_-]+)/i.exec(line)?.[1];
    const name = /"([^"]+)"/.exec(line)?.[1] ?? "";
    if (!ref || isFinalSubmitClickLabel(name)) {
      continue;
    }
    if (/nächste seite|naechste seite|next page|weiter/i.test(name)) {
      await client.click(ref);
      return { clicked: true, text: name, ref };
    }
  }
  return { clicked: false, reason: "no-safe-next-page" };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export async function discoverQuizTarget(
  config: MoodleRuntimeConfig,
  client: AgentBrowserClient,
): Promise<string | null> {
  const visited = new Set<string>();
  const queue: string[] = [config.moodleUrl || config.dashboardUrl];
  const candidates: QuizCandidate[] = [];
  const sourcesDir = path.join(config.runDir, "quiz-discovery-snapshots");
  await mkdir(sourcesDir, { recursive: true });

  while (queue.length && visited.size < Math.max(1, config.maxPages)) {
    const url = queue.shift();
    if (!url || visited.has(url)) {
      continue;
    }
    visited.add(url);
    await client.open(url);
    await client.wait(750);
    const snapshot = await client.snapshot({ interactive: true, urls: true, compact: true });
    await writeFile(
      path.join(sourcesDir, safeFileName(`${visited.size}-${url}.json`)),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    const links = extractLinksFromSnapshot(snapshot.snapshot, snapshot.refs);
    for (const link of links) {
      if (!link.href.startsWith(config.baseUrl)) {
        continue;
      }
      if (link.href.includes("/mod/quiz/")) {
        candidates.push({
          title: link.label,
          url: link.href,
          sourceUrl: url,
          score: scoreQuizCandidate(config.prompt, link.label, link.href, candidates.length),
        });
      } else if (
        (link.href.includes("/course/view.php") || link.href.includes("/my/")) &&
        isRelevantCourseLink(config.prompt, link.label, link.href) &&
        !visited.has(link.href) &&
        queue.length + visited.size < config.maxPages
      ) {
        queue.push(link.href);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  await writeFile(
    path.join(config.runDir, "quiz-candidates.json"),
    `${JSON.stringify(candidates, null, 2)}\n`,
    "utf8",
  );
  return candidates[0]?.url ?? null;
}

export async function extractQuizPage(client: AgentBrowserClient): Promise<QuizPageExtraction> {
  return client.evalJson<QuizPageExtraction>(QUESTION_EXTRACTION_JS);
}

export async function clickSafeStartOrContinue(
  client: AgentBrowserClient,
): Promise<{ clicked: boolean; text?: string; ref?: string; reason?: string }> {
  const snapshot = await client.snapshot({ interactive: true, compact: true });
  const startLine = snapshot.snapshot
    .split("\n")
    .map((line) => {
      const ref = /ref=([a-z0-9_-]+)/i.exec(line)?.[1];
      const name = /"([^"]+)"/.exec(line)?.[1] ?? "";
      return { line, ref, name };
    })
    .find(({ name }) => isStartOrContinueLabel(name));
  if (!startLine?.ref) {
    return { clicked: false, reason: "no-safe-start-control" };
  }
  if (isFinalSubmitClickLabel(startLine.name)) {
    return { clicked: false, reason: "blocked-final-submit-like-control", text: startLine.name };
  }
  await client.click(startLine.ref);
  return { clicked: true, text: startLine.name, ref: startLine.ref };
}

export async function openSafePreviousAttemptReview(
  client: AgentBrowserClient,
): Promise<{ clicked: boolean; text?: string; ref?: string; reason?: string }> {
  const snapshot = await client.snapshot({ interactive: true, compact: true, urls: true });
  const candidate = snapshot.snapshot
    .split("\n")
    .map((line) => {
      const ref = /ref=([a-z0-9_-]+)/i.exec(line)?.[1];
      const name = snapshot.refs[ref ?? ""]?.name ?? /"([^"]+)"/.exec(line)?.[1] ?? "";
      const href = /url=([^\]\s]+)/i.exec(line)?.[1] ?? "";
      return { ref, name, href };
    })
    .find(({ name, href }) =>
      Boolean(
        href &&
        /\/mod\/quiz\/review\.php\b/i.test(href) &&
        !isFinalSubmitClickLabel(name) &&
        !isStartOrContinueLabel(name),
      ),
    );
  if (!candidate?.ref) {
    return { clicked: false, reason: "no-safe-previous-attempt-review" };
  }
  await client.click(candidate.ref);
  return { clicked: true, text: candidate.name, ref: candidate.ref };
}

function isStartOrContinueLabel(label: string): boolean {
  return /test versuchen|versuch beginnen|versuch fortsetzen|attempt quiz|start attempt|continue attempt/i.test(
    label,
  );
}

function scoreQuizCandidate(prompt: string, title: string, url: string, index: number): number {
  const haystack = `${title} ${url}`.toLocaleLowerCase("de-AT");
  const terms = prompt.toLocaleLowerCase("de-AT").match(/[a-zA-ZäöüÄÖÜß0-9]{3,}/g) ?? [];
  let score = Math.max(0, 20 - index);
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length > 4 ? 5 : 2;
    }
  }
  if (/kommend|nächst|naechst|heutig|aktuell/.test(prompt.toLocaleLowerCase("de-AT"))) {
    score += Math.max(0, 15 - index);
  }
  if (
    /minitest|kurztest|moodle test/.test(prompt.toLocaleLowerCase("de-AT")) &&
    /minitest|kurztest|test/.test(haystack)
  ) {
    score += 12;
  }
  return score;
}

function isRelevantCourseLink(prompt: string, label: string, url: string): boolean {
  const haystack = `${label} ${url}`.toLocaleLowerCase("de-AT");
  const lower = prompt.toLocaleLowerCase("de-AT");
  if (/dyn2|anwendungen der dynamik/.test(lower)) {
    return /dyn2|anwendungen der dynamik/.test(haystack);
  }
  if (/phdyn|grundlagen der dynamik|physikalische grundlagen/.test(lower)) {
    return /phdyn|grundlagen der dynamik|physikalische grundlagen/.test(haystack);
  }
  if (/maes2|mathe|mathematik/.test(lower)) {
    return /maes2|mathematik|engineering science/.test(haystack);
  }
  if (/et2|elektrotechnik\s*2/.test(lower)) {
    return /(^|\W)et2(\W|$)|elektrotechnik\s*2/.test(haystack);
  }
  return /course\/view\.php/.test(url);
}

export function detectQuizRisks(bodyText: string): string[] {
  const risks: string[] = [];
  if (/submit all and finish|endgültig absenden|endgueltig absenden|alle abgeben/i.test(bodyText)) {
    risks.push("final-submit-control-visible");
  }
  if (/review|überprüfung|ueberpruefung|not currently available/i.test(bodyText)) {
    risks.push("review-or-unavailable-state");
  }
  return risks;
}

export function buildQuizReviewReport(input: {
  page: QuizPageExtraction;
  target: string;
  startResult: Record<string, unknown>;
  metadata?: QuizMetadata | undefined;
  policyDecision?: QuizPolicyDecision | undefined;
  risks: string[];
  fillResults?: Array<Record<string, unknown>>;
}): string {
  const lines = [
    "= Moodle Quiz Review",
    "",
    `Target: ${input.page.url || input.target}`,
    `Title: ${input.page.title || "Untitled"}`,
    `Visible questions: ${input.page.questions.length}`,
    `Start/continue clicked: ${Boolean(input.startResult.clicked)}`,
    "Final submit clicked: false",
    "Final submission policy: blocked/manual-only",
    "",
  ];
  if (input.metadata) {
    lines.push(
      "== Quiz Metadata",
      "",
      `- time limit: ${input.metadata.timeLimitMinutes ?? "unknown"} minute(s)`,
      `- attempts allowed: ${input.metadata.attemptsAllowed ?? "unknown"}`,
      `- attempts used: ${input.metadata.attemptsUsed ?? "unknown"}`,
      `- attempts left: ${input.metadata.attemptsLeft ?? "unknown"}`,
      `- active attempt visible: ${input.metadata.hasActiveAttempt}`,
      `- appears timed: ${input.metadata.appearsTimed}`,
      `- appears limited-attempt: ${input.metadata.appearsLimitedAttempt}`,
      "",
    );
  }
  if (input.policyDecision && input.policyDecision.status !== "allowed") {
    lines.push(
      "== Quiz Safety Stop",
      "",
      `- status: ${input.policyDecision.status}`,
      `- action: ${input.policyDecision.action}`,
      `- reason: ${input.policyDecision.reason}`,
      `- needed permission: ${input.policyDecision.neededPermission}`,
      "",
    );
  }
  if (input.risks.length) {
    lines.push("== Risk Flags", "", ...input.risks.map((risk) => `- ${risk}`), "");
  }
  if (input.fillResults?.length) {
    lines.push("== Fill Results", "");
    for (const result of input.fillResults) {
      if (result.action === "navigation") {
        lines.push(
          `- navigation page ${result.page_number}: clicked=${result.clicked} reason=${result.reason ?? ""}`,
        );
      } else if (result.action === "policy") {
        lines.push(
          `- policy ${result.policy_action}: status=${result.status} reason=${result.reason} needed_permission=${result.needed_permission}`,
        );
      } else {
        lines.push(
          `- question ${result.question_index}: filled=${Boolean(result.filled)} reason=${String(result.reason ?? "")}`,
        );
      }
    }
    lines.push("");
  }
  lines.push("== Questions", "");
  if (!input.page.questions.length) {
    lines.push("No visible questions were extracted.");
  }
  for (const question of input.page.questions) {
    lines.push(
      `=== Frage ${question.question_index}`,
      "",
      question.prompt || "No prompt extracted.",
      "",
    );
    for (const option of question.options) {
      lines.push(`- ${option}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function buildNoQuizReport(prompt: string): string {
  return [
    "= Moodle Quiz Review",
    "",
    `Prompt: ${prompt}`,
    "",
    "No matching Moodle quiz target was found in the inspected 2.0 crawl.",
    "",
    "Final submit clicked: false",
    "",
  ].join("\n");
}

export async function persistQuizArtifacts(
  config: MoodleRuntimeConfig,
  payload: {
    report: string;
    questions: QuizQuestion[];
    candidates: QuizCandidate[];
    targetUrl: string | null;
    finalSubmitClicked: boolean;
    startResult?: Record<string, unknown>;
    metadata?: QuizMetadata | undefined;
    policyDecision?: QuizPolicyDecision | undefined;
    risks?: string[];
    fillResults?: Array<Record<string, unknown>>;
  },
): Promise<void> {
  await mkdir(config.runDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(config.runDir, "quiz-review.typ"), payload.report, "utf8"),
    writeFile(
      path.join(config.runDir, "quiz-review.json"),
      `${JSON.stringify(
        {
          captured_at: new Date().toISOString(),
          prompt: config.prompt,
          target_url: payload.targetUrl,
          questions: payload.questions,
          candidates: payload.candidates,
          start_result: payload.startResult ?? {},
          quiz_metadata: payload.metadata ?? null,
          policy_decision: payload.policyDecision ?? null,
          risks: payload.risks ?? [],
          fill_results: payload.fillResults ?? [],
          final_submit_clicked: payload.finalSubmitClicked,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
}

async function stopForQuizPolicy(
  config: MoodleRuntimeConfig,
  state: LangGraphAgentState,
  target: string,
  decision: QuizPolicyDecision,
  metadata?: QuizMetadata,
): Promise<Partial<LangGraphAgentState>> {
  const page: QuizPageExtraction = {
    title: "Quiz Safety Stop",
    url: target,
    body_text: "",
    questions: [],
  };
  const fillResults = [policyDecisionResult(decision)];
  const report = buildQuizReviewReport({
    page,
    target,
    startResult: { clicked: false, reason: decision.reason },
    metadata,
    policyDecision: decision,
    risks: [],
    fillResults,
  });
  await persistQuizArtifacts(config, {
    report,
    questions: [],
    candidates: [],
    targetUrl: target,
    finalSubmitClicked: false,
    startResult: { clicked: false, reason: decision.reason },
    metadata,
    policyDecision: decision,
    risks: [],
    fillResults,
  });
  return {
    final_document: report,
    extracted_data: toJsonObject({
      kind: "quiz_review",
      status: decision.status,
      target_url: target,
      questions: [],
      quiz_metadata: metadata ?? null,
      policy_decision: decision,
      final_submit_clicked: false,
    }),
    source_coverage: {
      ...state.source_coverage,
      moodle: {
        status: "empty",
        detail: `Quiz safety stopped ${decision.action}: ${decision.reason}.`,
        urls: [target],
        pages: 1,
      },
    },
    error_log: null,
  };
}

export function policyDecisionResult(
  decision: QuizPolicyDecision,
  pageNumber?: number,
): Record<string, unknown> {
  return {
    ...(pageNumber === undefined ? {} : { page_number: pageNumber }),
    action: "policy",
    policy_action: decision.action,
    status: decision.status,
    filled: false,
    clicked: false,
    reason: decision.reason,
    needed_permission: decision.neededPermission,
  };
}

export function formatQuizRawText(page: QuizPageExtraction): string {
  return [
    "[Moodle quiz]",
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    "",
    ...page.questions.map((question) =>
      [
        `Question ${question.question_index}: ${question.prompt}`,
        ...question.options.map((option) => `- ${option}`),
      ].join("\n"),
    ),
  ].join("\n");
}
