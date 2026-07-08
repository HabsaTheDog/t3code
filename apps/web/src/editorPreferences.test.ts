import type { LocalApi } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { openInSystemApplication } from "./editorPreferences";

describe("openInSystemApplication", () => {
  it("uses the platform file manager so PDFs open in the system application", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const api = {
      shell: { openInEditor },
    } as unknown as LocalApi;

    await openInSystemApplication(api, "/home/student/Study Buddy/document.pdf");

    expect(openInEditor).toHaveBeenCalledWith(
      "/home/student/Study Buddy/document.pdf",
      "file-manager",
    );
  });
});
