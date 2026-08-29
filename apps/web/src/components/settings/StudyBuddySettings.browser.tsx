import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const config = {
    exists: true,
    moodleUsername: "student123",
    moodleDashboardUrl: "https://moodle.technikum-wien.at/my/",
    moodlePasswordConfigured: true,
    cisUsername: "student123",
    cisUrl: "https://cis.technikum-wien.at/cis.php/",
    cisPasswordConfigured: true,
    calendarUrl: "",
    calendarUrlConfigured: true,
    quiz: {
      accessMode: "review-only" as const,
      minimumTimeLimitMinutes: 10,
      minimumAttemptsLeft: 2,
      fillConfidenceThreshold: 0.85,
    },
  };
  const inventory = {
    version: 1 as const,
    revision: 0,
    adapters: [],
    connections: [
      {
        id: "moodle-connection",
        adapterId: "moodle",
        adapterVersion: "1",
        label: "Robotics Moodle",
        displayOrigin: "https://moodle.example.edu",
        entryPath: "/course/view.php?id=42",
        allowedOrigins: ["https://moodle.example.edu"],
        auth: { mode: "password" as const, state: "configured" as const },
        revision: 0,
      },
      {
        id: "calendar-connection",
        adapterId: "ical",
        adapterVersion: "1",
        label: "Personal calendar",
        displayOrigin: "https://calendar.example.edu",
        entryPath: "",
        allowedOrigins: ["https://calendar.example.edu"],
        auth: { mode: "bearer-url" as const, state: "configured" as const },
        revision: 0,
      },
      {
        id: "email-connection",
        adapterId: "sogo",
        adapterVersion: "1",
        label: "University email",
        displayOrigin: "https://mail.example.edu",
        entryPath: "/SOGo/",
        allowedOrigins: ["https://mail.example.edu"],
        auth: { mode: "password" as const, state: "configured" as const },
        emailProviderProfile: {
          id: "sogo" as const,
          label: "SOGo",
          discovery: "url-signature" as const,
          transport: "https-webmail" as const,
          readStateGuarantee: "unproven" as const,
        },
        revision: 0,
      },
    ],
    sources: [
      {
        id: "robotics-moodle",
        label: "Robotics Moodle",
        kind: "moodle-course" as const,
        enabled: true,
        connectionId: "moodle-connection",
        priority: 100,
        scope: {
          allowedOrigins: ["https://moodle.example.edu"],
          pathPrefixes: ["/course/"],
          courseIds: [],
          mailFolders: [],
          tags: [],
        },
        capabilities: ["content.read" as const, "course.structure.read" as const],
        policy: {
          authenticatedReads: "allowed" as const,
          downloads: "allowed" as const,
          remoteDrafts: "denied" as const,
          emailSend: "denied" as const,
        },
        health: { status: "unknown" as const },
        revision: 0,
      },
      {
        id: "personal-calendar",
        label: "Personal calendar",
        kind: "calendar" as const,
        enabled: true,
        connectionId: "calendar-connection",
        priority: 200,
        scope: {
          allowedOrigins: ["https://calendar.example.edu"],
          pathPrefixes: [],
          courseIds: [],
          mailFolders: [],
          tags: [],
        },
        capabilities: ["calendar.events.read" as const],
        policy: {
          authenticatedReads: "allowed" as const,
          downloads: "denied" as const,
          remoteDrafts: "denied" as const,
          emailSend: "denied" as const,
        },
        health: { status: "unknown" as const },
        revision: 0,
      },
      {
        id: "university-email",
        label: "University email",
        kind: "email" as const,
        enabled: true,
        connectionId: "email-connection",
        priority: 300,
        scope: {
          allowedOrigins: ["https://mail.example.edu"],
          pathPrefixes: ["/SOGo/"],
          courseIds: [],
          mailFolders: ["INBOX"],
          tags: [],
        },
        capabilities: ["mail.threads.list" as const, "mail.message.read" as const],
        policy: {
          authenticatedReads: "allowed" as const,
          downloads: "denied" as const,
          remoteDrafts: "denied" as const,
          emailSend: "denied" as const,
        },
        health: { status: "unknown" as const },
        revision: 0,
      },
    ],
  };
  const settings = { personalityPrompt: "Be direct and call me Alex." };
  return {
    config,
    inventory,
    settings,
    getConfiguration: vi.fn(async () => config),
    updateConfiguration: vi.fn(async () => config),
    getInventory: vi.fn(async () => inventory),
    createSource: vi.fn(async () => inventory),
    updateSource: vi.fn(async () => inventory),
    deleteSource: vi.fn(async () => inventory),
    setSourceAuth: vi.fn(async () => inventory),
    updateEmailPermissions: vi.fn(async () => inventory),
    testSource: vi.fn(async ({ sourceId }: { sourceId: string }) => ({
      sourceId,
      status: "success" as const,
      code: sourceId === "university-email" ? "email-read-state-preserved" : "ok",
      message:
        sourceId === "university-email"
          ? "Email is connected. Opening messages here keeps their read status unchanged."
          : "Connection succeeded.",
      checkedAt: "2026-08-14T10:00:00.000Z",
    })),
    listEmailMessages: vi.fn(async () => ({ sourceId: "university-email", messages: [] })),
    searchEmailMessages: vi.fn(async () => ({ sourceId: "university-email", messages: [] })),
    readEmailMessage: vi.fn(async () => {
      throw new Error("No message selected");
    }),
    reset() {
      this.getConfiguration.mockClear();
      this.getInventory.mockClear();
      this.createSource.mockClear();
      this.updateSource.mockClear();
      this.setSourceAuth.mockClear();
      this.updateEmailPermissions.mockClear();
      this.testSource.mockClear();
    },
  };
});

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    server: {
      getStudyBuddyConfiguration: harness.getConfiguration,
      updateStudyBuddyConfiguration: harness.updateConfiguration,
      getStudyBuddySourceInventory: harness.getInventory,
      createStudyBuddySource: harness.createSource,
      updateStudyBuddySource: harness.updateSource,
      deleteStudyBuddySource: harness.deleteSource,
      setStudyBuddySourceAuth: harness.setSourceAuth,
      updateStudyBuddyEmailPermissions: harness.updateEmailPermissions,
      testStudyBuddySource: harness.testSource,
      listStudyBuddyEmailMessages: harness.listEmailMessages,
      searchStudyBuddyEmailMessages: harness.searchEmailMessages,
      readStudyBuddyEmailMessage: harness.readEmailMessage,
    },
  }),
}));

vi.mock("~/telemetry/runtime", () => ({ telemetry: { capture: vi.fn(async () => undefined) } }));
vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => harness.settings,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("~/lib/desktopSpeechReactQuery", () => ({
  useDesktopSpeechState: () => ({ data: { status: "not-enabled" } }),
  useDesktopSpeechActions: () => ({ enable: vi.fn(), remove: vi.fn() }),
}));

import { StudyBuddySettingsPanel } from "./StudyBuddySettings";

describe("Study Buddy source settings", () => {
  beforeEach(() => harness.reset());
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows source blocks with only safe public origins", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await expect
      .element(page.getByRole("heading", { name: "Robotics Moodle" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("https://moodle.example.edu/course/view.php?id=42"))
      .toBeInTheDocument();
    await expect.element(page.getByText("https://calendar.example.edu")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private-token");
    await expect.element(page.getByText("One-time approval")).toBeInTheDocument();
    await mounted.unmount();
  });

  it("offers plain per-account read, draft, and send-request permissions", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Add another source" }).click();
    await page.getByRole("radio", { name: /Email/ }).click();
    await expect.element(page.getByText("Name in Study Buddy")).toBeVisible();
    await expect.element(page.getByText("Read email", { exact: true }).last()).toBeInTheDocument();
    await expect
      .element(page.getByText("Prepare drafts", { exact: true }).last())
      .toBeInTheDocument();
    await expect.element(page.getByText("Ask to send", { exact: true }).last()).toBeInTheDocument();
    await expect.element(page.getByRole("switch", { name: "Read email" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Prepare drafts" })).not.toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Ask to send" })).toBeDisabled();
    await expect
      .element(
        page.getByText(
          "Study Buddy cannot delete, move, archive, or mark messages as read. Sending is possible only after you approve the exact email in chat.",
        ),
      )
      .toBeInTheDocument();
    await mounted.unmount();
  });

  it("changes an email account permission directly in settings", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);

    await page.getByRole("switch", { name: "Prepare drafts for University email" }).click();

    expect(harness.updateEmailPermissions).toHaveBeenCalledWith({
      expectedRevision: 0,
      sourceId: "university-email",
      read: true,
      draft: true,
      send: false,
      senderEmail: null,
    });
    await mounted.unmount();
  });

  it("discovers an HTTPS SOGo profile and keeps read access fail-closed", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Add another source" }).click();
    await page.getByRole("radio", { name: /Email/ }).click();
    await page
      .getByRole("textbox", { name: "Email website or server" })
      .fill("https://mail.example.edu/SOGo/");

    await expect.element(page.getByText("We found SOGo")).toBeInTheDocument();
    await expect.element(page.getByText("Recognized from the address.")).toBeInTheDocument();

    await mounted.unmount();
  });

  it("unlocks email reading after the connection check verifies message status is preserved", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    const readButton = page.getByRole("button", {
      name: "Read University email without changing unread status",
    });

    await expect.element(page.getByText("Check first to enable mail")).toBeInTheDocument();
    await expect.element(page.getByText("Messages", { exact: true })).toBeInTheDocument();
    await expect.element(readButton).toBeDisabled();

    await page.getByRole("button", { name: "Check University email connection" }).click();

    await expect.element(page.getByText("Ready to read")).toBeInTheDocument();
    await expect.element(readButton).toBeEnabled();
    expect(harness.testSource).toHaveBeenCalledWith({ sourceId: "university-email" });
    await mounted.unmount();
  });

  it("refreshes the revision after a connection check before editing", async () => {
    const refreshedInventory = {
      ...harness.inventory,
      revision: 1,
    };
    harness.getInventory
      .mockResolvedValueOnce(harness.inventory)
      .mockResolvedValueOnce(refreshedInventory);
    harness.updateSource.mockResolvedValueOnce({ ...refreshedInventory, revision: 2 });

    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Check Robotics Moodle connection" }).click();
    await vi.waitFor(() => expect(harness.getInventory).toHaveBeenCalledTimes(2));
    await page.getByRole("button", { name: "Edit Robotics Moodle" }).click();
    await page.getByRole("textbox", { name: "Name in Study Buddy" }).fill("Robotics portal");
    await page.getByRole("button", { name: "Save changes" }).click();

    expect(harness.updateSource).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, sourceId: "robotics-moodle" }),
    );
    await mounted.unmount();
  });

  it("replaces a saved private calendar link from the edit dialog", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Edit Personal calendar" }).click();
    await page
      .getByRole("textbox", { name: "Private calendar link" })
      .fill("https://calendar.example.edu/new-private-feed.ics");
    await page.getByRole("button", { name: "Save changes" }).click();

    expect(harness.setSourceAuth).toHaveBeenCalledWith({
      operation: "set-bearer-url",
      expectedRevision: 0,
      sourceId: "personal-calendar",
      value: "https://calendar.example.edu/new-private-feed.ics",
    });
    await mounted.unmount();
  });

  it("saves Ask to send as a one-time approval permission with the sender address", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Edit University email" }).click();
    await page.getByRole("switch", { name: "Ask to send" }).click();
    await expect.element(page.getByRole("switch", { name: "Prepare drafts" })).toBeChecked();
    await page
      .getByRole("textbox", { name: "Email address used to send" })
      .fill("student@example.edu");
    await page.getByRole("button", { name: "Save changes" }).click();

    expect(harness.updateEmailPermissions).toHaveBeenCalledWith({
      expectedRevision: 0,
      sourceId: "university-email",
      read: true,
      draft: true,
      send: true,
      senderEmail: "student@example.edu",
    });
    await mounted.unmount();
  });

  it("rejects credential-bearing website addresses before creating a source", async () => {
    const mounted = await render(<StudyBuddySettingsPanel />);
    await page.getByRole("button", { name: "Add another source" }).click();
    await page.getByRole("radio", { name: /Website/ }).click();
    await page
      .getByRole("textbox", { name: "Website address" })
      .fill("https://student:secret@example.edu/portal");
    await page.getByRole("button", { name: "Add source" }).last().click();
    await expect.element(page.getByText(/Remove the sign-in details/)).toBeInTheDocument();
    expect(harness.createSource).not.toHaveBeenCalled();
    await mounted.unmount();
  });
});
