import { describe, expect, it } from "vite-plus/test";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
import { buildStudyBuddyDeveloperInstructions } from "./CodexDeveloperInstructions.js";

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
    expect(instructions).toContain("every Study Buddy wrapper and web-layout command");
    expect(instructions.match(/--profile-overrides-json/g)).toHaveLength(1);
    const match = instructions.match(/--profile-overrides-json '([^']+)'/)!;
    expect(JSON.parse(match[1]!)).toMatchObject({
      solution_generation: { model: "gpt-specialized" },
      source_search: base.taskOverrides!.source_search,
      content_repair: base.taskOverrides!.content_repair,
    });
  });
});
