import { type ModelSelection, type ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpIncomingMessage,
} from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

const route = "/api/study-buddy/model";
const image = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  data: Schema.String.check(Schema.isMaxLength(14_000_000)),
});
const requestSchema = Schema.Struct({
  threadId: ThreadId,
  prompt: Schema.String.check(Schema.isMaxLength(200_000)),
  model: Schema.optional(Schema.String),
  images: Schema.Array(image).check(Schema.isMaxLength(20)),
  outputSchema: Schema.optional(Schema.Unknown),
  context: Schema.optional(Schema.Boolean),
});

const decodeRequest = Schema.decodeUnknownEffect(requestSchema);
const encodeOutputSchema = Schema.encodeEffect(Schema.UnknownFromJsonString);

export function modelBridgeEnvironment(input: {
  port: number;
  workflowToken: string;
  threadId: string;
  modelSelection: ModelSelection;
  driver: ProviderDriverKind;
}): Record<string, string> {
  if (input.driver === "codex") return {};
  return {
    STUDY_BUDDY_MODEL_BRIDGE_URL: `http://127.0.0.1:${input.port}${route}`,
    STUDY_BUDDY_MODEL_BRIDGE_TOKEN: input.workflowToken,
    STUDY_BUDDY_MODEL_BRIDGE_MODEL: input.modelSelection.model,
    STUDY_BUDDY_MODEL_BRIDGE_PROVIDER: input.driver,
    STUDY_BUDDY_MODEL_BRIDGE_THREAD: input.threadId,
  };
}

export const studyBuddyModelRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const registry = yield* ProviderInstanceRegistry;
    const projection = yield* ProjectionSnapshotQuery;
    return HttpRouter.add(
      "POST",
      route,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        const url = HttpServerRequest.toURL(request);
        if (
          config.mode !== "desktop" ||
          Option.isNone(runtime) ||
          Option.isNone(url) ||
          url.value.hostname !== "127.0.0.1" ||
          request.headers.authorization !== `Bearer ${runtime.value.workflowToken}`
        )
          return HttpServerResponse.jsonUnsafe(
            { error: "Unauthorized model request." },
            { status: 403 },
          );
        const body = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(64 * 1024 * 1024)),
          Effect.flatMap(decodeRequest),
          Effect.option,
        );
        if (Option.isNone(body))
          return HttpServerResponse.jsonUnsafe(
            { error: "Invalid model request." },
            { status: 400 },
          );
        const input = body.value;
        const thread = yield* projection
          .getThreadDetailById(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(thread) || !thread.value || thread.value.deletedAt !== null)
          return HttpServerResponse.jsonUnsafe(
            { error: "Workflow thread is unavailable." },
            { status: 404 },
          );
        if (input.context) {
          const turn = thread.value.latestTurn;
          const message =
            turn &&
            thread.value.messages.findLast(
              (entry) => entry.role === "user" && entry.createdAt <= turn.requestedAt,
            );
          if (!turn || turn.state !== "running" || !message)
            return HttpServerResponse.jsonUnsafe(
              { error: "Workflow owner is no longer running." },
              { status: 409 },
            );
          const providerInput = (message.attachments ?? []).some((entry) => entry.type === "voice")
            ? yield* projection.getMessageProviderInput(input.threadId, message.id)
            : Option.none();
          return HttpServerResponse.jsonUnsafe({
            turnId: turn.turnId,
            originalUserPrompt: Option.getOrElse(providerInput, () => message.text),
            images: (message.attachments ?? []).flatMap((attachment) => {
              const file = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              return file ? [file] : [];
            }),
          });
        }
        const selected = thread.value.modelSelection;
        const instance = yield* registry.getInstance(selected.instanceId);
        if (!instance?.enabled || !instance.textGeneration.generateWorkflow)
          return HttpServerResponse.jsonUnsafe(
            { error: "Selected provider cannot run workflow workers." },
            { status: 409 },
          );
        const catalog = yield* instance.snapshot.getSnapshot;
        const model = input.model ?? selected.model;
        if (model !== selected.model && !catalog.models.some((entry) => entry.slug === model))
          return HttpServerResponse.jsonUnsafe(
            { error: "Model is unavailable for the selected provider." },
            { status: 409 },
          );
        const schema =
          input.outputSchema === undefined
            ? ""
            : yield* encodeOutputSchema(input.outputSchema).pipe(Effect.orElseSucceed(() => ""));
        if (schema.length > 100_000)
          return HttpServerResponse.jsonUnsafe(
            { error: "Output schema is too large." },
            { status: 400 },
          );
        const generated = yield* instance.textGeneration
          .generateWorkflow({
            modelSelection: { ...selected, model },
            images: input.images,
            prompt: [
              "Perform the following Study Buddy transformation from supplied evidence only. Never use tools or delegate further.",
              "Return a JSON object with one string field named result. That string must contain the complete requested output without enclosing markdown fences.",
              ...(schema
                ? [`The result string must itself be JSON matching this output schema: ${schema}`]
                : []),
              "BEGIN WORKFLOW PROMPT",
              input.prompt,
              "END WORKFLOW PROMPT",
            ].join("\n"),
          })
          .pipe(Effect.option);
        return Option.isSome(generated)
          ? HttpServerResponse.jsonUnsafe({ text: generated.value.result })
          : HttpServerResponse.jsonUnsafe(
              { error: "Selected provider worker failed." },
              { status: 502 },
            );
      }),
    );
  }),
);

export const providerWorkflowEnvironment = (input: {
  threadId: string;
  modelSelection?: ModelSelection | undefined;
  driver: ProviderDriverKind;
  cwd?: string | undefined;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return {
      STUDY_BUDDY_THREAD_ID: input.threadId,
      ...(input.driver !== "codex" ? { STUDY_BUDDY_MODEL_BRIDGE_PROVIDER: input.driver } : {}),
      ...(input.cwd ? { STUDY_BUDDY_WORKSPACE: input.cwd } : {}),
      ...(Option.isSome(runtime) && input.modelSelection
        ? modelBridgeEnvironment({
            ...runtime.value,
            ...input,
            modelSelection: input.modelSelection,
          })
        : {}),
    };
  });
