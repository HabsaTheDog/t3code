// @effect-diagnostics nodeBuiltinImport:off -- HTTP boundary fixture owns a temporary runtime-state file.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import {
  duplicateStudyBuddyProfile,
  STUDY_BUDDY_BUILT_IN_PROFILES,
} from "@t3tools/shared/studyBuddyProfiles";
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
      const profile = duplicateStudyBuddyProfile(STUDY_BUDDY_BUILT_IN_PROFILES[1]!, "mixed-test");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        studyBuddyExecutionProfileId: "mixed-test",
        studyBuddyCustomExecutionProfiles: [
          {
            ...profile,
            roles: {
              ...profile.roles,
              coordinator: { ...profile.roles.coordinator, ...selection },
              artifactBuilder: {
                ...profile.roles.artifactBuilder,
                instanceId: ProviderInstanceId.make("codex-secondary"),
              },
            },
          },
        ],
      };
      let connected = true;
      const getInstance = vi.fn(() =>
        Effect.succeed({
          enabled: true,
          textGeneration: { generateWorkflow },
          snapshot: {
            getSnapshot: Effect.sync(() => ({
              instanceId: selection.instanceId,
              driver: ProviderDriverKind.make(driver),
              installed: true,
              status: "ready",
              auth: { status: connected ? "authenticated" : "unauthenticated" },
              models: [
                { slug: "selected-model", name: "Selected", isCustom: false },
                { slug: "gpt-5.6-sol", name: "Builder", isCustom: false },
                { slug: "foreign-gpt-model", name: "Unassigned", isCustom: false },
              ],
            })),
          },
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
          Layer.provide(
            Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
          ),
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
        expect(
          (await request({ threadId: "owner", prompt: "no stopped worker", images: [] })).status,
        ).toBe(409);
        ownerRunning = true;
        const mixed = await request({
          threadId: "owner",
          instanceId: "codex-secondary",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          prompt: "Mixed evidence α",
          images: [],
        });
        expect(mixed.status).toBe(200);
        expect(getInstance).toHaveBeenCalledWith("codex-secondary");
        expect(generateWorkflow.mock.lastCall![0]).toMatchObject({
          modelSelection: {
            instanceId: "codex-secondary",
            model: "gpt-5.6-sol",
            options: [
              { id: driver === "claudeAgent" ? "effort" : "reasoningEffort", value: "medium" },
            ],
          },
        });
        expect(
          (
            await request({
              threadId: "owner",
              instanceId: "unassigned-account",
              model: "selected-model",
              prompt: "do not route",
              images: [],
            })
          ).status,
        ).toBe(409);
        connected = false;
        expect(
          (
            await request({
              threadId: "owner",
              instanceId: "codex-secondary",
              model: "gpt-5.6-sol",
              prompt: "disconnected",
              images: [],
            })
          ).status,
        ).toBe(409);
        connected = true;
        generateWorkflow.mockClear();
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
        for (const [detail, status, safeError] of [
          ["authentication failed secret-token", 401, "Provider authentication failed."],
          ["insufficient_quota secret-token", 402, "Provider usage limit reached."],
          ["rate_limit secret-token", 429, "Provider rate limit reached."],
          ["model overloaded secret-token", 503, "Provider model capacity unavailable."],
          ["model not found secret-token", 409, "Provider model unavailable."],
          ["unexpected failure secret-token", 502, "Selected provider worker failed."],
        ] as const) {
          generateWorkflow.mockReturnValueOnce(
            Effect.fail(new TextGenerationError({ operation: "workflow", detail })) as never,
          );
          const failed = await request({ threadId: "owner", prompt: "evidence", images: [] });
          expect(failed.status).toBe(status);
          expect(await failed.json()).toEqual({ error: safeError });
        }
      } finally {
        await app.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("exports bridge context for native and mixed Codex workers", () => {
    const common = {
      port: 12345,
      workflowToken: "fixture",
      threadId: ThreadId.make("owner"),
      modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini" },
    };
    expect(
      modelBridgeEnvironment({ ...common, driver: ProviderDriverKind.make("codex") }),
    ).toMatchObject({
      STUDY_BUDDY_MODEL_BRIDGE_PROVIDER: "codex",
      STUDY_BUDDY_MODEL_BRIDGE_THREAD: "owner",
    });
    expect(
      modelBridgeEnvironment({ ...common, driver: ProviderDriverKind.make("antigravity") }),
    ).toMatchObject({
      STUDY_BUDDY_MODEL_BRIDGE_THREAD: "owner",
      STUDY_BUDDY_MODEL_BRIDGE_MODEL: "gemini",
      STUDY_BUDDY_MODEL_BRIDGE_PROVIDER: "antigravity",
    });
  });
});
