import { z } from "zod";

export const SourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum([
    "moodle_page",
    "cis_page",
    "calendar_event",
    "pdf",
    "file",
    "quiz_question",
    "assignment",
    "local_file",
  ]),
  url: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  page: z.number().int().positive().nullable().optional(),
});

export const FormulaSchema = z.object({
  name: z.string().min(1),
  typst: z.string().min(1),
  variables: z.array(z.string()).default([]),
  units: z.array(z.string()).default([]),
  context: z.string().default(""),
  source_ids: z.array(z.string()).default([]),
});

export const SectionSchema = z.object({
  heading: z.string().min(1),
  summary: z.string().min(1),
  key_concepts: z.array(z.string()).default([]),
  source_ids: z.array(z.string()).default([]),
});

export const WorkedExampleSchema = z.object({
  prompt: z.string().min(1),
  steps: z.array(z.string()).default([]),
  result: z.string().default(""),
  source_ids: z.array(z.string()).default([]),
});

export const QuizStyleQuestionSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  source_ids: z.array(z.string()).default([]),
});

export const ExtractedDataSchema = z.object({
  document_title: z.string().min(1),
  language: z.enum(["de", "en"]).default("de"),
  course: z.object({
    title: z.string().default("n/a"),
    url: z.string().default(""),
  }),
  sources: z.array(SourceSchema).default([]),
  sections: z.array(SectionSchema).default([]),
  formulas: z.array(FormulaSchema).default([]),
  worked_examples: z.array(WorkedExampleSchema).default([]),
  quiz_style_questions: z.array(QuizStyleQuestionSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type ExtractedData = z.infer<typeof ExtractedDataSchema>;

const strictStringArrayJsonSchema = {
  type: "array",
  items: { type: "string" },
} as const;

const nonEmptyStringJsonSchema = { type: "string", minLength: 1 } as const;

const strictSourceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: nonEmptyStringJsonSchema,
    title: nonEmptyStringJsonSchema,
    kind: {
      type: "string",
      enum: [
        "moodle_page",
        "cis_page",
        "calendar_event",
        "pdf",
        "file",
        "quiz_question",
        "assignment",
        "local_file",
      ],
    },
    url: { type: ["string", "null"] },
    path: { type: ["string", "null"] },
    page: { type: ["integer", "null"], minimum: 1 },
  },
  required: ["id", "title", "kind", "url", "path", "page"],
} as const;

const strictSectionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    heading: nonEmptyStringJsonSchema,
    summary: nonEmptyStringJsonSchema,
    key_concepts: strictStringArrayJsonSchema,
    source_ids: strictStringArrayJsonSchema,
  },
  required: ["heading", "summary", "key_concepts", "source_ids"],
} as const;

const strictFormulaJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: nonEmptyStringJsonSchema,
    typst: nonEmptyStringJsonSchema,
    variables: strictStringArrayJsonSchema,
    units: strictStringArrayJsonSchema,
    context: { type: "string" },
    source_ids: strictStringArrayJsonSchema,
  },
  required: ["name", "typst", "variables", "units", "context", "source_ids"],
} as const;

const strictWorkedExampleJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: nonEmptyStringJsonSchema,
    steps: strictStringArrayJsonSchema,
    result: { type: "string" },
    source_ids: strictStringArrayJsonSchema,
  },
  required: ["prompt", "steps", "result", "source_ids"],
} as const;

const strictQuizStyleQuestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: nonEmptyStringJsonSchema,
    answer: nonEmptyStringJsonSchema,
    source_ids: strictStringArrayJsonSchema,
  },
  required: ["question", "answer", "source_ids"],
} as const;

export const extractedDataJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    document_title: nonEmptyStringJsonSchema,
    language: { type: "string", enum: ["de", "en"] },
    course: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        url: { type: "string" },
      },
      required: ["title", "url"],
    },
    sources: { type: "array", items: strictSourceJsonSchema },
    sections: { type: "array", items: strictSectionJsonSchema },
    formulas: { type: "array", items: strictFormulaJsonSchema },
    worked_examples: { type: "array", items: strictWorkedExampleJsonSchema },
    quiz_style_questions: { type: "array", items: strictQuizStyleQuestionJsonSchema },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "document_title",
    "language",
    "course",
    "sources",
    "sections",
    "formulas",
    "worked_examples",
    "quiz_style_questions",
    "warnings",
  ],
} as const;
