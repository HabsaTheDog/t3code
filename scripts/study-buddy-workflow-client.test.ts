// @effect-diagnostics nodeBuiltinImport:off - This test exercises the dependency-free packaged Node client directly.
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

// @ts-expect-error The shipped client intentionally stays dependency-free JavaScript.
import { maybeRunBrokeredWorkflow } from "./study-buddy-workflow-client.mjs";

describe("packaged Study Buddy workflow client", () => {
  it("routes workflow commands to the loopback broker without source credentials", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ exitCode: 0, stdout: "run-dir\n", stderr: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const stdout = vi.fn();
    const stderr = vi.fn();
    const exitCode = await maybeRunBrokeredWorkflow(["interactive-study-guide", "test"], {
      environment: {
        STUDY_BUDDY_CONFIG_ROOT: path.resolve("/private/state"),
        STUDY_BUDDY_WORKSPACE: path.resolve("/workspace"),
        STUDY_BUDDY_THREAD_ID: "thread-1",
      },
      readRuntimeState: async () => JSON.stringify({ version: 1, port: 45678 }),
      fetchImpl,
      writeStdout: stdout,
      writeStderr: stderr,
    });

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:45678/api/study-buddy/workflow",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchImpl.mock.calls[0]![1];
    expect(request.body).toBe(
      JSON.stringify({
        args: ["interactive-study-guide", "test"],
        workspace: path.resolve("/workspace"),
        threadId: "thread-1",
      }),
    );
    expect(request.body).not.toContain("MOODLE_PASSWORD");
    expect(stdout).toHaveBeenCalledWith("run-dir\n");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("bypasses the broker for the server-owned child execution", async () => {
    const fetchImpl = vi.fn();
    await expect(
      maybeRunBrokeredWorkflow(["interactive-study-guide", "test"], {
        environment: { STUDY_BUDDY_BROKER_EXECUTION: "1" },
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
