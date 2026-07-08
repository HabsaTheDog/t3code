import { describe, expect, it } from "vitest";
import type { CodexClient } from "../codexClient.ts";
import { runSchemaSmoke } from "../schemaSmoke.ts";
import { extractedDataJsonSchema } from "../schemas.ts";

describe("extractedDataJsonSchema", () => {
  it("uses strict closed objects for structured output", () => {
    const violations: string[] = [];
    assertStrictObjectSchema(extractedDataJsonSchema, "$", violations);
    expect(violations).toEqual([]);
  });

  it("is used by the schema smoke runner", async () => {
    let observedSchema: unknown;
    const codex: CodexClient = {
      async run(_prompt, options) {
        observedSchema = options?.outputSchema;
        return JSON.stringify({
          document_title: "Smoke",
          language: "de",
          course: { title: "n/a", url: "" },
          sources: [
            {
              id: "s1",
              title: "Smoke source",
              kind: "local_file",
              url: null,
              path: null,
              page: null,
            },
          ],
          sections: [],
          formulas: [],
          worked_examples: [],
          quiz_style_questions: [],
          warnings: [],
        });
      },
    };

    await expect(runSchemaSmoke(codex)).resolves.toMatchObject({
      document_title: "Smoke",
      sources: [{ id: "s1", page: null }],
    });
    expect(observedSchema).toBe(extractedDataJsonSchema);
  });
});

function assertStrictObjectSchema(schema: unknown, path: string, violations: string[]): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const candidate = schema as {
    type?: string | readonly string[];
    additionalProperties?: unknown;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    items?: unknown;
  };
  const typeValues = Array.isArray(candidate.type) ? candidate.type : [candidate.type];
  const isObject = typeValues.includes("object");

  if (isObject) {
    if (candidate.additionalProperties !== false) {
      violations.push(`${path}: missing additionalProperties: false`);
    }
    const propertyKeys = Object.keys(candidate.properties ?? {}).sort();
    const requiredKeys = [...(candidate.required ?? [])].sort();
    if (JSON.stringify(propertyKeys) !== JSON.stringify(requiredKeys)) {
      violations.push(`${path}: required keys do not match properties`);
    }
  }

  for (const [key, value] of Object.entries(candidate.properties ?? {})) {
    assertStrictObjectSchema(value, `${path}.properties.${key}`, violations);
  }
  if (candidate.items) {
    assertStrictObjectSchema(candidate.items, `${path}.items`, violations);
  }
}
