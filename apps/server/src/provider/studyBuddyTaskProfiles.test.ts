import { describe, expect, it } from "vite-plus/test";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
import { buildStudyBuddyDeveloperInstructions } from "./CodexDeveloperInstructions.js";

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
  expect(instructions).toContain("Only persisted:true establishes a successful save");
  expect(instructions).toContain("Recovery reads only the bound first attempt");
  expect(instructions).toContain("Never use the second attempt");
  expect(instructions).toContain("Never apply one quiz's approval to another");
  expect(instructions).not.toContain('prompt "<exact quiz prompt>" --auto-answer');
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
