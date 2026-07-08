// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  FilesystemCreatePreviewTicketInput,
  FilesystemPreviewTicket,
  OrchestrationReadModel,
  PreviewFileKind,
} from "@t3tools/contracts";

const PREVIEW_ROUTE_PREFIX = "/api/filesystem/preview/";
const TICKET_TTL_MS = 5 * 60_000;
const MIB = 1024 * 1024;

interface StoredPreviewTicket {
  readonly absolutePath: string;
  readonly expiresAtMs: number;
  readonly fileKind: PreviewFileKind;
  readonly mimeType: string;
  readonly size: number;
}

const tickets = new Map<string, StoredPreviewTicket>();

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function classifyPreviewFile(filePath: string): {
  readonly fileKind: PreviewFileKind;
  readonly mimeType: string;
  readonly maxBytes: number;
} {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return { fileKind: "pdf", mimeType: "application/pdf", maxBytes: 100 * MIB };
  }
  if (extension === ".html" || extension === ".htm") {
    return { fileKind: "html", mimeType: "text/html; charset=utf-8", maxBytes: 10 * MIB };
  }
  const imageMimeType = IMAGE_MIME_TYPES[extension];
  if (imageMimeType) {
    return { fileKind: "image", mimeType: imageMimeType, maxBytes: 100 * MIB };
  }
  if (extension === ".md" || extension === ".markdown") {
    return { fileKind: "markdown", mimeType: "text/markdown; charset=utf-8", maxBytes: 5 * MIB };
  }
  if (
    [".css", ".csv", ".json", ".log", ".text", ".txt", ".xml", ".yaml", ".yml"].includes(extension)
  ) {
    return { fileKind: "text", mimeType: "text/plain; charset=utf-8", maxBytes: 5 * MIB };
  }
  return {
    fileKind: "file",
    mimeType: "application/octet-stream",
    maxBytes: 100 * MIB,
  };
}

function resolvePreviewRoot(
  input: FilesystemCreatePreviewTicketInput,
  snapshot: OrchestrationReadModel,
): string | null {
  const scope = input.scope;
  if (scope.kind === "project") {
    return (
      snapshot.projects.find(
        (project) => project.id === scope.projectId && project.deletedAt === null,
      )?.workspaceRoot ?? null
    );
  }

  const thread = snapshot.threads.find((entry) => entry.id === scope.threadId);
  if (!thread) return null;
  const project = snapshot.projects.find(
    (entry) => entry.id === thread.projectId && entry.deletedAt === null,
  );
  if (!project) return null;
  return thread.worktreePath ?? project.workspaceRoot;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function purgeExpiredTickets(now = Date.now()): void {
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAtMs <= now) {
      tickets.delete(token);
    }
  }
}

export async function createFilesystemPreviewTicket(
  input: FilesystemCreatePreviewTicketInput,
  snapshot: OrchestrationReadModel,
): Promise<FilesystemPreviewTicket> {
  const root = resolvePreviewRoot(input, snapshot);
  if (!root) {
    throw new Error("Preview scope does not exist.");
  }

  const realRoot = await realpath(root);
  const requestedPath = path.isAbsolute(input.filePath)
    ? input.filePath
    : path.resolve(realRoot, input.filePath);
  const absolutePath = await realpath(requestedPath);
  if (!isWithinRoot(realRoot, absolutePath)) {
    throw new Error("Preview file must stay within the selected workspace.");
  }

  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile()) {
    throw new Error("Preview path is not a file.");
  }

  const classification = classifyPreviewFile(absolutePath);
  if (fileInfo.size > classification.maxBytes) {
    throw new Error(
      `Preview file exceeds the ${Math.floor(classification.maxBytes / MIB)} MiB limit.`,
    );
  }

  purgeExpiredTickets();
  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + TICKET_TTL_MS;
  tickets.set(token, {
    absolutePath,
    expiresAtMs,
    fileKind: classification.fileKind,
    mimeType: classification.mimeType,
    size: fileInfo.size,
  });

  return {
    path: `${PREVIEW_ROUTE_PREFIX}${token}`,
    fileName: path.basename(absolutePath),
    fileKind: classification.fileKind,
    mimeType: classification.mimeType,
    size: fileInfo.size,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function readFilesystemPreviewTicket(token: string): StoredPreviewTicket | null {
  const ticket = tickets.get(token);
  if (!ticket) return null;
  if (ticket.expiresAtMs <= Date.now()) {
    tickets.delete(token);
    return null;
  }
  return ticket;
}

export function previewResponseHeaders(ticket: StoredPreviewTicket): Record<string, string> {
  const isHtml = ticket.fileKind === "html";
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": isHtml
      ? "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"
      : "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; object-src 'self'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

export { PREVIEW_ROUTE_PREFIX };
