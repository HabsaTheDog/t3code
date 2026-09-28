// @effect-diagnostics nodeBuiltinImport:off -- HTTP boundary fixture owns a temporary runtime-state file.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, vi } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { WorkflowGenerationInput } from "../textGeneration/TextGeneration.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { modelBridgeEnvironment, studyBuddyModelRouteLayer } from "./studyBuddyModelBridge.ts";

describe("Study Buddy model bridge", () => {
  it.each(["claudeAgent", "antigravity"])(
    "enforces auth and routes %s workers to the owning thread instance",
    async (driver) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "study-buddy-model-bridge-"));
      const runtimePath = path.join(directory, "runtime.json");
      await writeFile(
        runtimePath,
        JSON.stringify({
          version: 1,
          pid: 1,
          port: 12345,
          origin: "http://127.0.0.1:12345",
          startedAt: "2026-09-22T00:00:00Z",
          workflowToken: "fixture-token",
        }),
      );
      const selection = {
        instanceId: ProviderInstanceId.make(`custom-${driver}`),
        model: "selected-model",
      };
      const generateWorkflow = vi.fn((_input: WorkflowGenerationInput) =>
        Effect.succeed({ result: "verified output" }),
      );
      const getInstance = vi.fn(() =>
        Effect.succeed({
          enabled: true,
          textGeneration: { generateWorkflow },
          snapshot: { getSnapshot: Effect.succeed({ models: [] }) },
        } as unknown as ProviderInstance),
      );
      let ownerRunning = true;
      let voice = false;
      const owner = () => ({
        deletedAt: null,
        modelSelection: selection,
        latestTurn: {
          turnId: "active-turn",
          state: ownerRunning ? "running" : "interrupted",
          requestedAt: "2026-09-22T10:00:01Z",
        },
        messages: [
          {
            id: "original-message",
            role: "user",
            createdAt: "2026-09-22T10:00:00Z",
            text: "Exact request: α\nUse this card.",
            attachments: [
              ...(voice ? [{ type: "voice", id: "voice-one", durationMs: 1000 }] : []),
              {
                type: "image",
                id: "card-image",
                name: "card.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          },
          {
            role: "user",
            createdAt: "2026-09-22T10:00:02Z",
            text: "Queued next request",
            attachments: [],
          },
        ],
      });
      const app = HttpRouter.toWebHandler(
        studyBuddyModelRouteLayer.pipe(
          Layer.provide(
            Layer.effect(
              ServerConfig,
              Effect.map(ServerConfig, (config) => ({
                ...config,
                mode: "desktop" as const,
                serverRuntimeStatePath: runtimePath,
              })),
            ).pipe(Layer.provide(ServerConfig.layerTest(directory, directory))),
          ),
          Layer.provide(
            Layer.mock(ProjectionSnapshotQuery)({
              getMessageProviderInput: (id, messageId) =>
                Effect.succeed(
                  id === "owner" && messageId === "original-message"
                    ? Option.some("Exact spoken request α")
                    : Option.none(),
                ),
              getThreadDetailById: (id) =>
                Effect.succeed(id === "owner" ? Option.some(owner() as never) : Option.none()),
            }),
          ),
          Layer.provide(Layer.mock(ProviderInstanceRegistry)({ getInstance })),
          Layer.provideMerge(NodeServices.layer),
        ),
      );
      const request = (body: unknown, token = "fixture-token") =>
        app.handler(
          new Request("http://127.0.0.1:12345/api/study-buddy/model", {
            method: "POST",
            headers: {
              host: "127.0.0.1:12345",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );
      try {
        expect(
          (await request({ threadId: "owner", prompt: "secret", images: [] }, "wrong")).status,
        ).toBe(403);
        expect((await request({ threadId: "missing", prompt: "secret", images: [] })).status).toBe(
          404,
        );
        expect(
          (
            await request({
              threadId: "owner",
              prompt: "secret",
              images: [],
              model: "foreign-gpt-model",
            })
          ).status,
        ).toBe(409);
        expect(generateWorkflow).not.toHaveBeenCalled();
        expect(
          (await request({ threadId: "owner", prompt: "", images: [], context: true }, "wrong"))
            .status,
        ).toBe(403);
        const context = await request({ threadId: "owner", prompt: "", images: [], context: true });
        expect(context.status).toBe(200);
        expect(await context.json()).toEqual({
          turnId: "active-turn",
          originalUserPrompt: "Exact request: α\nUse this card.",
          images: [expect.stringMatching(/card-image\.png$/)],
        });
        expect(generateWorkflow).not.toHaveBeenCalled();
        voice = true;
        const spoken = await request({ threadId: "owner", prompt: "", images: [], context: true });
        expect(await spoken.json()).toMatchObject({ originalUserPrompt: "Exact spoken request α" });
        voice = false;
        ownerRunning = false;
        expect(
          (await request({ threadId: "owner", prompt: "", images: [], context: true })).status,
        ).toBe(409);
        ownerRunning = true;
        const response = await request({
          threadId: "owner",
          prompt: "Exact evidence: α\nnext line",
          images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
          outputSchema: { type: "object" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ text: "verified output" });
        expect(getInstance).toHaveBeenLastCalledWith(selection.instanceId);
        expect(generateWorkflow.mock.calls[0]?.[0]).toMatchObject({
          modelSelection: selection,
          images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
        });
        expect(generateWorkflow.mock.calls[0]?.[0]?.prompt).toContain(
          "Exact evidence: α\nnext line",
        );
      } finally {
        await app.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("exports provider routing only for native workers", () => {
    const common = {
      port: 12345,
      workflowToken: "fixture",
      threadId: ThreadId.make("owner"),
      modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini" },
    };
    expect(modelBridgeEnvironment({ ...common, driver: ProviderDriverKind.make("codex") })).toEqual(
      {},
    );
    expect(
      modelBridgeEnvironment({ ...common, driver: ProviderDriverKind.make("antigravity") }),
    ).toMatchObject({
      STUDY_BUDDY_MODEL_BRIDGE_THREAD: "owner",
      STUDY_BUDDY_MODEL_BRIDGE_MODEL: "gemini",
      STUDY_BUDDY_MODEL_BRIDGE_PROVIDER: "antigravity",
    });
  });
});
