import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const PreviewFileKind = Schema.Literals([
  "pdf",
  "html",
  "image",
  "markdown",
  "text",
  "file",
]);
export type PreviewFileKind = typeof PreviewFileKind.Type;

export const PreviewScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: ProjectId,
  }),
]);
export type PreviewScope = typeof PreviewScope.Type;

export const FilesystemCreatePreviewTicketInput = Schema.Struct({
  scope: PreviewScope,
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type FilesystemCreatePreviewTicketInput = typeof FilesystemCreatePreviewTicketInput.Type;

export const FilesystemPreviewTicket = Schema.Struct({
  path: TrimmedNonEmptyString,
  fileName: TrimmedNonEmptyString,
  fileKind: PreviewFileKind,
  mimeType: TrimmedNonEmptyString,
  size: NonNegativeInt,
  expiresAt: TrimmedNonEmptyString,
});
export type FilesystemPreviewTicket = typeof FilesystemPreviewTicket.Type;

export class FilesystemPreviewError extends Schema.TaggedErrorClass<FilesystemPreviewError>()(
  "FilesystemPreviewError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
