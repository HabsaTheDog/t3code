import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireQuickChatCreation,
  isQuickChatSubmitting,
  markQuickChatSubmitting,
  releaseQuickChatCreation,
  resetQuickChatLifecycleForTests,
} from "./quickChatLifecycle";

describe("quickChatLifecycle", () => {
  afterEach(resetQuickChatLifecycleForTests);

  it("acquires creation synchronously and only once per environment", () => {
    const environmentId = EnvironmentId.make("local");
    expect(acquireQuickChatCreation(environmentId)).toBe(true);
    expect(acquireQuickChatCreation(environmentId)).toBe(false);
    releaseQuickChatCreation(environmentId);
    expect(acquireQuickChatCreation(environmentId)).toBe(true);
  });

  it("protects a project for the full first-send critical section", () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("quick-chat");
    const release = markQuickChatSubmitting(environmentId, projectId);
    const releaseSecond = markQuickChatSubmitting(environmentId, projectId);
    expect(isQuickChatSubmitting(environmentId, projectId)).toBe(true);
    release();
    expect(isQuickChatSubmitting(environmentId, projectId)).toBe(true);
    releaseSecond();
    expect(isQuickChatSubmitting(environmentId, projectId)).toBe(false);
  });
});
