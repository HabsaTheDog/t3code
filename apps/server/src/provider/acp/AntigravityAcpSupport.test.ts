import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ChatAttachment,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  antigravityPermissionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
} from "./AntigravityAcpSupport.ts";

const modelConfig = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "gemini-default",
  options: [
    { value: "gemini-default", name: "Gemini default" },
    { value: "gemini-saved", name: "Gemini saved" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

function makeModelRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [modelConfig],
  failure?: EffectAcpErrors.AcpError,
) {
  const selections: string[] = [];
  const setModel = Effect.fn("AntigravityAcpSupportTest.setModel")(function* (model: string) {
    if (failure) return yield* failure;
    selections.push(model);
  });
  return {
    runtime: { getConfigOptions: Effect.succeed(configOptions), setModel },
    selections,
  };
}

describe("applyAntigravityAcpModelSelection", () => {
  it.effect("restores the saved model instead of the cold-resume default", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect("reapplies an explicit selection even when setup reports the same model", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime([
        { ...modelConfig, currentValue: "gemini-saved" },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect.each([undefined, null, ANTIGRAVITY_DEFAULT_MODEL])(
    "uses the native default for %s without sending an internal model ID",
    (requestedModel) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const model = yield* applyAntigravityAcpModelSelection({
          runtime,
          model: requestedModel,
          mapError: (cause) => cause,
        });

        expect(model).toBe("gemini-default");
        expect(selections).toEqual([]);
      }),
  );

  it.effect("selects the manifest default for the alias when the account offers it", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-saved",
        mapError: (cause) => cause,
      });
      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);

      const { runtime: other, selections: otherSelections } = makeModelRuntime();
      const fallback = yield* applyAntigravityAcpModelSelection({
        runtime: other,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-not-offered",
        mapError: (cause) => cause,
      });
      expect(fallback).toBe("gemini-default");
      expect(otherSelections).toEqual([]);
    }),
  );

  it.effect.each(["gemini-removed", "Gemini saved", "gemini-saved[reasoning=high]"])(
    "rejects unavailable or non-native model ID %s without selecting a fallback",
    (model) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const error = yield* applyAntigravityAcpModelSelection({
          runtime,
          model,
          mapError: (cause) => cause,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRequestError",
          code: -32602,
          errorMessage: expect.stringContaining(`'${model}' is unavailable`),
        });
        expect(selections).toEqual([]);
      }),
  );

  it.effect("accepts exact model IDs from grouped native options", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime([
        {
          ...modelConfig,
          options: [{ group: "gemini", name: "Gemini", options: modelConfig.options }],
        },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect("reports a native model-selection failure through the adapter error mapper", () =>
    Effect.gen(function* () {
      const nativeError = EffectAcpErrors.AcpRequestError.invalidParams("Model access changed.");
      const { runtime } = makeModelRuntime([modelConfig], nativeError);
      const error = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => ({ operation: "select-model", cause }),
      }).pipe(Effect.flip);

      expect(error).toEqual({ operation: "select-model", cause: nativeError });
    }),
  );
});

describe("antigravityPermissionMode", () => {
  it.each([
    { runtimeMode: "approval-required", nativeMode: "default" },
    { runtimeMode: "auto-accept-edits", nativeMode: "auto_edit" },
    { runtimeMode: "full-access", nativeMode: "yolo" },
  ] satisfies ReadonlyArray<{ runtimeMode: RuntimeMode; nativeMode: string }>)(
    "maps $runtimeMode to $nativeMode",
    ({ runtimeMode, nativeMode }) => {
      expect(antigravityPermissionMode(runtimeMode)).toBe(nativeMode);
    },
  );
});

const imageAttachment = {
  type: "image",
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
} satisfies ChatAttachment;

const makeAttachmentFixture = Effect.fn("AntigravityAcpSupportTest.makeAttachmentFixture")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-antigravity-attachments-",
    });
    const write = Effect.fn("AntigravityAcpSupportTest.writeAttachment")(function* (
      attachment: ChatAttachment,
      content: string | Uint8Array,
    ) {
      const filePath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (filePath === null) throw new Error("Invalid test attachment path.");
      if (typeof content === "string") yield* fs.writeFileString(filePath, content);
      else yield* fs.writeFile(filePath, content);
      return { filePath, uri: (yield* path.toFileUrl(filePath)).href };
    });
    return { fs, attachmentsDir, write };
  },
);

it.layer(NodeServices.layer)("buildAntigravityPrompt", (it) => {
  it.effect("sends image bytes as native image content alongside the user prompt", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=",
        "base64",
      );
      yield* fixture.write(imageAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "  Explain this image.  ",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      });

      expect(prompt).toEqual([
        { type: "text", text: "  Explain this image.  " },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
    }),
  );

  it.effect("rejects a missing attachment", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const result = yield* buildAntigravityPrompt({
        input: "x",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);
      expect(result._tag).toBe("AcpRequestError");
    }),
  );
  it.effect("rejects empty prompts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const result = yield* buildAntigravityPrompt({
        input: " ",
        attachments: [],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);
      expect(result._tag).toBe("AcpRequestError");
    }),
  );
});
