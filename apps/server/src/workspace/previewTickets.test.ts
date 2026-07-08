// @effect-diagnostics nodeBuiltinImport:off
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createFilesystemPreviewTicket, readFilesystemPreviewTicket } from "./previewTickets.ts";

const temporaryDirectories: string[] = [];

async function createFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "t3-preview-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside.pdf");
  await mkdir(root);
  await writeFile(path.join(root, "document.pdf"), "%PDF-test");
  await writeFile(outside, "%PDF-outside");
  return { base, root, outside };
}

function snapshot(root: string): OrchestrationReadModel {
  const projectId = ProjectId.make("project-1");
  return {
    projects: [
      {
        id: projectId,
        workspaceRoot: root,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId,
        worktreePath: null,
      },
    ],
  } as unknown as OrchestrationReadModel;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("filesystem preview tickets", () => {
  it("creates a short-lived ticket for a file inside the thread workspace", async () => {
    const fixture = await createFixture();
    const result = await createFilesystemPreviewTicket(
      {
        scope: { kind: "thread", threadId: ThreadId.make("thread-1") },
        filePath: "document.pdf",
      },
      snapshot(fixture.root),
    );

    expect(result).toMatchObject({
      fileKind: "pdf",
      mimeType: "application/pdf",
      fileName: "document.pdf",
    });
    const token = result.path.slice(result.path.lastIndexOf("/") + 1);
    expect(readFilesystemPreviewTicket(token)?.absolutePath).toBe(
      path.join(fixture.root, "document.pdf"),
    );
  });

  it("rejects traversal and symlink escapes", async () => {
    const fixture = await createFixture();
    await symlink(fixture.outside, path.join(fixture.root, "escaped.pdf"));
    const currentSnapshot = snapshot(fixture.root);

    await expect(
      createFilesystemPreviewTicket(
        {
          scope: { kind: "thread", threadId: ThreadId.make("thread-1") },
          filePath: "../outside.pdf",
        },
        currentSnapshot,
      ),
    ).rejects.toThrow("must stay within");
    await expect(
      createFilesystemPreviewTicket(
        {
          scope: { kind: "thread", threadId: ThreadId.make("thread-1") },
          filePath: "escaped.pdf",
        },
        currentSnapshot,
      ),
    ).rejects.toThrow("must stay within");
  });

  it("applies the lower HTML size limit", async () => {
    const fixture = await createFixture();
    const htmlPath = path.join(fixture.root, "large.html");
    await writeFile(htmlPath, "");
    await truncate(htmlPath, 10 * 1024 * 1024 + 1);

    await expect(
      createFilesystemPreviewTicket(
        {
          scope: { kind: "project", projectId: ProjectId.make("project-1") },
          filePath: htmlPath,
        },
        snapshot(fixture.root),
      ),
    ).rejects.toThrow("10 MiB");
  });
});
