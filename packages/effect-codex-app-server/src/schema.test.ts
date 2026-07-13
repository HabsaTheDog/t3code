import * as Schema from "effect/Schema";

import { assert, describe, it } from "@effect/vitest";

import * as CodexSchema from "./schema.ts";

const decodeModelListResponse = Schema.decodeUnknownSync(CodexSchema.V2ModelListResponse);
const decodeModelListReasoningEffort = Schema.decodeUnknownSync(
  CodexSchema.V2ModelListResponse__ReasoningEffort,
);
const decodeTurnStartReasoningEffort = Schema.decodeUnknownSync(
  CodexSchema.V2TurnStartParams__ReasoningEffort,
);

describe("Codex app-server schemas", () => {
  it("accepts model-defined reasoning efforts in model/list responses", () => {
    const response = decodeModelListResponse({
      data: [
        {
          id: "gpt-future",
          model: "gpt-future",
          displayName: "GPT Future",
          description: "A future model",
          defaultReasoningEffort: "extra",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "extra", description: "More reasoning" },
          ],
          hidden: false,
          isDefault: true,
        },
      ],
      nextCursor: null,
    });

    assert.equal(response.data[0]?.defaultReasoningEffort, "extra");
    assert.equal(response.data[0]?.supportedReasoningEfforts[1]?.reasoningEffort, "extra");
  });

  it("accepts model-defined reasoning efforts in turn/start requests", () => {
    assert.equal(decodeTurnStartReasoningEffort("extra"), "extra");
  });

  it("rejects an empty reasoning effort", () => {
    assert.throws(() => decodeModelListReasoningEffort(""));
  });
});
