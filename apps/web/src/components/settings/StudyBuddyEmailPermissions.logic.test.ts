import type { StudyBuddySourceInventory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emailPermissionState,
  isEmailAddress,
  optimisticEmailPermissionInventory,
} from "./StudyBuddyEmailPermissions.logic";

const inventory: StudyBuddySourceInventory = {
  version: 1,
  revision: 4,
  adapters: [],
  connections: [
    {
      id: "university-mail-connection",
      adapterId: "sogo",
      adapterVersion: "1",
      label: "University email",
      displayOrigin: "https://mail.example.edu",
      entryPath: "/SOGo/",
      allowedOrigins: ["https://mail.example.edu"],
      auth: {
        mode: "password",
        state: "configured",
        accountLabel: "student@example.edu",
      },
      revision: 1,
    },
  ],
  sources: [
    {
      id: "university-mail",
      label: "University email",
      kind: "email",
      enabled: true,
      connectionId: "university-mail-connection",
      priority: 100,
      scope: {
        allowedOrigins: ["https://mail.example.edu"],
        pathPrefixes: ["/SOGo/"],
        courseIds: [],
        mailFolders: ["INBOX"],
        tags: [],
      },
      capabilities: ["mail.threads.list", "mail.message.read"],
      policy: {
        authenticatedReads: "allowed",
        downloads: "denied",
        remoteDrafts: "denied",
        emailSend: "denied",
      },
      health: { status: "connected" },
      revision: 1,
    },
  ],
};

describe("Study Buddy email permission controls", () => {
  it("derives student-facing permissions and suggests an email-shaped account name", () => {
    expect(emailPermissionState(inventory.sources[0]!, inventory.connections[0])).toEqual({
      read: true,
      draft: false,
      send: false,
      senderEmail: "student@example.edu",
      sendingSupported: true,
    });
  });

  it("optimistically applies the same permission shape returned by the server", () => {
    const updated = optimisticEmailPermissionInventory(inventory, "university-mail", {
      read: true,
      draft: true,
      send: true,
      senderEmail: "student@example.edu",
    });
    expect(updated.sources[0]?.capabilities).toEqual([
      "mail.threads.list",
      "mail.message.read",
      "mail.draft.local",
      "mail.send",
    ]);
    expect(updated.sources[0]?.policy).toMatchObject({
      authenticatedReads: "allowed",
      remoteDrafts: "allowed",
      emailSend: "approval-required",
    });
    expect(updated.connections[0]?.auth.emailAddress).toBe("student@example.edu");
  });

  it("accepts normal email addresses and rejects incomplete or injected values", () => {
    expect(isEmailAddress("student@example.edu")).toBe(true);
    expect(isEmailAddress("student")).toBe(false);
    expect(isEmailAddress("student@example.edu\nBcc: attacker@example.edu")).toBe(false);
  });
});
