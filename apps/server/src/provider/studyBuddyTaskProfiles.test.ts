import { describe, expect, it } from "vite-plus/test";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
import {
  appendStudyBuddyDeveloperInstructions,
  buildStudyBuddyDeveloperInstructions,
} from "./CodexDeveloperInstructions.js";

const CLI_DEFAULT_TOOL_RULES = `Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.
Use the \`request_user_input\` tool only for optional questions where the answer would materially improve the quality of the work.
If \`request_user_input\` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.
Never use the \`request_user_input\` tool for permission requests or permission-related escalations.`;

it("keeps CLI system permission restrictions while distinguishing the Study Buddy application choice", () => {
  const instructions = appendStudyBuddyDeveloperInstructions(CLI_DEFAULT_TOOL_RULES, {
    environment: { STUDY_BUDDY_ROOT: "/study-buddy" },
  });
  expect(instructions.startsWith(`${CLI_DEFAULT_TOOL_RULES}\n\n`)).toBe(true);
  const core = instructions.slice(
    instructions.indexOf("## Core Rule"),
    instructions.indexOf("## Tooling"),
  );
  expect(core).toContain("application-domain choice");
  expect(core).toContain("not a Codex filesystem/network permission request or escalation");
  expect(core).toContain("System permissions still use the Codex permission protocol");
  expect(core).toContain("when the native tool is listed, call it");
  expect(core).toContain("actual tool error before claiming the approval UI is unavailable");
  const safety = instructions.slice(instructions.indexOf("## Safety And Output"));
  expect(safety).toContain("no answer does not grant quiz access");
  expect(safety).toContain(
    "Do not send a final assistant response while this permission is pending",
  );
  expect(safety).toContain(
    "If the user declines, stop without changing the configured access mode",
  );
});

it("does not override the CLI tool constraints outside the Study Buddy branch", () => {
  expect(appendStudyBuddyDeveloperInstructions(CLI_DEFAULT_TOOL_RULES, { environment: {} })).toBe(
    CLI_DEFAULT_TOOL_RULES,
  );
});

it("requires a working artifact for answer-checking exercises while preserving conversational requests", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy" },
  });
  expect(instructions).toContain("exercise with an answer checker");
  expect(instructions).toContain("generate and publish a validated offline HTML artifact");
  expect(instructions).toContain("requests explicitly limited to chat as conversational answers");
  expect(instructions).toContain("include the published file link");
  expect(buildStudyBuddyDeveloperInstructions({ environment: {} })).toBeUndefined();
});

it("keeps quiz solving native and binds continuation to the first attempt", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
  })!;
  expect(instructions).toContain("/app/task quiz");
  expect(instructions).toContain("Delegate independent questions to native subagents");
  expect(instructions).toContain("serialize browser operations within each attempt");
  expect(instructions).toContain("permissionRequestPath");
  expect(instructions).toContain("packetDigest");
  expect(instructions).toContain('"op":"collect"');
  expect(instructions).toContain('"op":"complete"');
  expect(instructions).toContain("Do not stop after the first question");
  expect(instructions).toContain("shared_page_context");
  expect(instructions).toContain("full source resolution");
  expect(instructions).toContain("progress.complete:true");
  expect(instructions).toContain("Only persisted:true establishes a successful save");
  expect(instructions).toContain("Recovery reads only the bound first attempt");
  expect(instructions).toContain("Never use the second attempt");
  expect(instructions).toContain("Never apply one quiz's approval to another");
  expect(instructions).not.toContain('prompt "<exact quiz prompt>" --auto-answer');
});

it("gives execution of a real quiz priority before generic routing or a loaded legacy skill", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
  })!;
  const priority = instructions.indexOf(
    "Real Moodle quiz attempts take priority over generic source routing",
  );
  expect(priority).toBeGreaterThan(instructions.indexOf("## Core Rule"));
  expect(priority).toBeLessThan(instructions.indexOf("## Tooling"));
  expect(instructions).toContain(
    "use /app/task quiz '<JSON>' and read-only /app/task sources '<JSON>'",
  );
  expect(instructions).toContain(
    "including when a loaded skill recommends the legacy auto-answer pipeline",
  );
  expect(instructions).toContain("The app broker rejects legacy --auto-answer execution");
});

it("preserves the exact quiz request in inspect JSON instead of forcing a positional legacy prompt", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy" },
  })!;
  expect(instructions).toContain(
    "For quiz JSON tools, put the exact latest user message in inspect.prompt",
  );
  expect(instructions).toContain(
    "do not create a positional prompt command or rephrase the request to force a legacy route",
  );
  expect(instructions).toContain(
    "For model-backed wrapper commands that accept a positional prompt",
  );
  expect(instructions).not.toContain(
    "Pass the latest user message as a non-empty, safely quoted literal in the same wrapper command.",
  );
});

it("separates informational mini-test overviews from executing an actual quiz", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
  })!;
  expect(instructions).toContain(
    "Weekly preparation, task status, mini-test information and self-study overviews only",
  );
  expect(instructions).toContain(
    "This route does not execute quiz attempts; doing, solving or filling a real quiz uses Direct Quiz",
  );
  expect(instructions).not.toContain(
    "Weekly preparation, tasks, mini-tests and self-study overviews:",
  );
});

describe("profile task handoff", () => {
  it("includes specialized tasks once and requires them for every workflow route", () => {
    const base = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "custom-task");
    const instructions = buildStudyBuddyDeveloperInstructions({
      environment: { STUDY_BUDDY_ROOT: "/study-buddy", HOME: "/test-home" },
      executionProfile: "custom",
      executionProfileConfig: {
        ...base,
        taskOverrides: {
          ...base.taskOverrides,
          solution_generation: { ...base.roles.contentAnalyzer, model: "gpt-specialized" },
        },
      },
    })!;
    expect(instructions).toContain("every model-backed Study Buddy wrapper and web-layout command");
    expect(instructions.match(/--profile-overrides-json/g)).toHaveLength(1);
    const match = instructions.match(/--profile-overrides-json '([^']+)'/)!;
    expect(JSON.parse(match[1]!)).toMatchObject({
      solution_generation: { model: "gpt-specialized" },
      source_search: base.taskOverrides!.source_search,
      content_repair: base.taskOverrides!.content_repair,
    });
  });
});

it("uses one native owner and direct deterministic tools for PDFs", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
  })!;
  expect(instructions).toContain("YOU are the single document author");
  expect(instructions).toContain("compatibility entry only prepares this same direct document");
  expect(instructions).toContain("does not start background extraction");
  expect(instructions).toContain("syntaxExamplePath before writing");
  expect(instructions).toContain("Update the existing file or write it once");
  expect(instructions).toContain("validate generated question premises independently of answers");
  expect(instructions).toContain("never LaTeX left/right");
  expect(instructions).toContain("actual small local Python or shell calculation");
  expect(instructions).toContain("does not insert delimiters");
  expect(instructions).toContain("quoted strings containing dollar math print raw markup");
  expect(instructions).toContain("technical terms verbatim in attributed definitions");
  expect(instructions).toContain("Define symbols once in the core equation legend");
  expect(instructions).toContain("Omit unsolicited redundant technical checklists");
  expect(instructions).toContain("frac(full numerator, full denominator)");
  expect(instructions).toContain("only after actually reading them in that material");
  expect(instructions).toContain("not formula provenance");
  expect(instructions).toContain(
    "every technical definition, variable legend and explanatory note",
  );
  expect(instructions).toContain("derivative order agrees with the displayed operator");
  expect(instructions).toContain("supplemental standard knowledge as your own explanation");
  expect(instructions).toContain("/app/task document");
  expect(instructions).toContain("/app/task sources");
  expect(instructions).toContain(
    "no additional model-backed extraction, formatting or review stage",
  );
  expect(instructions).toContain("Stop after three unsuccessful compile/validation attempts");
  expect(instructions).toContain("Never submit final Moodle quiz/exam attempts");
  expect(instructions).not.toContain("only PDF orchestration route");
  expect(instructions).not.toContain("A Moodle PDF is publishable only when its extraction");
});

it("links durable workspace deliverables instead of temporary T3 attachment copies", () => {
  const instructions = buildStudyBuddyDeveloperInstructions({
    environment: { STUDY_BUDDY_ROOT: "/study-buddy", STUDY_BUDDY_TASK_WRAPPER: "/app/task" },
  })!;
  expect(instructions).toContain("study-buddy-deliverables/");
  expect(instructions).toContain("Link the returned deliveryPath directly");
  expect(instructions).toContain(
    "Temporary-file delivery instructions in shared skills apply to external T3 sessions",
  );
  expect(instructions).toContain(
    "do not copy the final attachment to a system temporary directory",
  );
  expect(instructions).not.toContain("/tmp/<descriptive-filename>.pdf");
  expect(instructions).toContain("[study-guide.pdf](<returned deliveryPath>)");
  expect(instructions).toContain("[study-guide.pdf](study-buddy-deliverables/study-guide.pdf)");
  expect(instructions).not.toContain("a workspace/output path as the final delivery link");
});
