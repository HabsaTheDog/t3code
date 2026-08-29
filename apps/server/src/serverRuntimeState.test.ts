// @effect-diagnostics nodeBuiltinImport:off -- Verifies native owner-only file permissions.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { persistServerRuntimeState } from "./serverRuntimeState.ts";

describe("persisted server runtime state", () => {
  it("stores the workflow capability with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "study-buddy-runtime-state-"));
    const filePath = path.join(directory, "server-runtime.json");
    try {
      await Effect.runPromise(
        persistServerRuntimeState({
          path: filePath,
          state: {
            version: 1,
            pid: 123,
            port: 45678,
            origin: "http://127.0.0.1:45678",
            startedAt: "2026-08-29T20:00:00.000Z",
            workflowToken: "a".repeat(43),
          },
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
