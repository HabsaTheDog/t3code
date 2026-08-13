// @effect-diagnostics nodeBuiltinImport:off
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MessageId, ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFilesystemPreviewTicket,
  previewResponseHeaders,
  readFilesystemPreviewTicket,
} from "./previewTickets.ts";

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

function snapshot(
  root: string,
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly streaming?: boolean;
  }> = [],
): OrchestrationReadModel {
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
        messages: messages.map((message, index) => ({
          id: MessageId.make(`message-${index + 1}`),
          role: message.role,
          text: message.text,
          streaming: message.streaming ?? false,
          turnId: null,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        })),
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

  it("previews an exact temporary delivery linked by a completed assistant message", async () => {
    const fixture = await createFixture();
    const deliveredPdf = path.join(fixture.base, "dynamik-study-guide.pdf");
    await writeFile(deliveredPdf, "%PDF-delivered");

    const result = await createFilesystemPreviewTicket(
      {
        scope: { kind: "thread", threadId: ThreadId.make("thread-1") },
        filePath: deliveredPdf,
      },
      snapshot(fixture.root, [
        {
          role: "assistant",
          text: `[dynamik-study-guide.pdf](${deliveredPdf})`,
        },
      ]),
    );

    expect(result).toMatchObject({
      fileKind: "pdf",
      fileName: "dynamik-study-guide.pdf",
      mimeType: "application/pdf",
    });
    const token = result.path.slice(result.path.lastIndexOf("/") + 1);
    expect(readFilesystemPreviewTicket(token)?.absolutePath).toBe(deliveredPdf);
  });

  it("rejects unreferenced and non-assistant temporary files", async () => {
    const fixture = await createFixture();
    const deliveredPdf = path.join(fixture.base, "private.pdf");
    await writeFile(deliveredPdf, "%PDF-private");
    const input = {
      scope: { kind: "thread" as const, threadId: ThreadId.make("thread-1") },
      filePath: deliveredPdf,
    };

    await expect(createFilesystemPreviewTicket(input, snapshot(fixture.root))).rejects.toThrow(
      "must stay within",
    );
    await expect(
      createFilesystemPreviewTicket(
        input,
        snapshot(fixture.root, [
          { role: "user", text: `[private.pdf](${deliveredPdf})` },
          {
            role: "assistant",
            text: `[private.pdf](${deliveredPdf})`,
            streaming: true,
          },
        ]),
      ),
    ).rejects.toThrow("must stay within");
  });

  it("rejects temporary delivery symlinks even when an assistant linked them", async () => {
    const fixture = await createFixture();
    const deliveredLink = path.join(fixture.base, "linked.pdf");
    await symlink(fixture.outside, deliveredLink);

    await expect(
      createFilesystemPreviewTicket(
        {
          scope: { kind: "thread", threadId: ThreadId.make("thread-1") },
          filePath: deliveredLink,
        },
        snapshot(fixture.root, [{ role: "assistant", text: `[linked.pdf](${deliveredLink})` }]),
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

  it("keeps executable HTML previews offline and unable to submit forms", async () => {
    const fixture = await createFixture();
    const htmlPath = path.join(fixture.root, "guide.html");
    await writeFile(htmlPath, "<script>document.body.textContent = 'interactive'</script>");
    const result = await createFilesystemPreviewTicket(
      {
        scope: { kind: "project", projectId: ProjectId.make("project-1") },
        filePath: htmlPath,
      },
      snapshot(fixture.root),
    );
    const token = result.path.slice(result.path.lastIndexOf("/") + 1);
    const ticket = readFilesystemPreviewTicket(token);

    expect(ticket).not.toBeNull();
    expect(previewResponseHeaders(ticket!)["Content-Security-Policy"]).toBe(
      "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });
});
