// @effect-diagnostics nodeBuiltinImport:off -- Isolated filesystem fixtures for source persistence.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ServerSecretStoreShape } from "../../auth/ServerSecretStore.ts";
import type { ServerConfigShape } from "../../config.ts";
import { createStudyBuddySourcePlatform } from "./sourcePlatform.ts";
import type { StudyBuddyWebmailRuntime } from "./webmailProfileRuntime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function harness(options: { webmailRuntime?: StudyBuddyWebmailRuntime } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "study-buddy-email-source-"));
  temporaryDirectories.push(directory);
  const values = new Map<string, Uint8Array>();
  const secrets: ServerSecretStoreShape = {
    get: (name) => Effect.succeed(values.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  const config = {
    cwd: directory,
    stateDir: path.join(directory, "state"),
    secretsDir: path.join(directory, "secrets"),
  } as ServerConfigShape;
  return {
    directory,
    platform: createStudyBuddySourcePlatform(config, secrets, {
      discoverWebmailProvider: async (url) => ({
        profile: {
          id: "sogo",
          label: "SOGo Webmail",
          transport: "web-session",
          authentication: {
            kind: "form-session",
            endpoint: "connect",
            usernameField: "userName",
            passwordField: "password",
          },
          strategies: { list: "list", search: "search", read: "peek" },
          readState: { invariant: "peek-only", proven: true, verification: "test" },
          runtime: "available",
        },
        confidence: "high",
        baseUrl: url,
        allowedOrigins: [new URL(url).origin],
        evidence: ["fixture"],
        researchMetadata: {
          finalUrl: url,
          status: 200,
          formActions: ["/SOGo/connect"],
          fieldNames: ["userName", "password"],
          assetHints: [],
          headerNames: [],
          bodyFingerprint: "fixture",
        },
      }),
      ...(options.webmailRuntime
        ? { emailBrokerDependencies: { webmailRuntime: options.webmailRuntime } }
        : {}),
    }),
  };
}

describe("Study Buddy IMAP source configuration", () => {
  it("persists only a sanitized IMAPS origin while keeping credentials in the secret store", async () => {
    const { directory, platform } = await harness();
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "University mail",
      url: "imaps://mail.example.edu:993",
      enabled: true,
      auth: {
        operation: "set-password",
        username: "student@example.edu",
        password: "app-password",
      },
    });

    const source = inventory.sources.find((entry) => entry.kind === "email");
    const connection = inventory.connections.find((entry) => entry.id === source?.connectionId);
    expect(source?.scope.mailFolders).toEqual(["INBOX"]);
    expect(connection).toMatchObject({
      adapterId: "imap",
      displayOrigin: "imaps://mail.example.edu:993",
      entryPath: "",
      auth: { mode: "password", state: "configured", accountLabel: "student@example.edu" },
    });

    const registry = await readFile(
      path.join(directory, "state", "study-buddy-sources.json"),
      "utf8",
    );
    expect(registry).not.toContain("app-password");
  });

  it("profiles an HTTPS webmail URL without putting credentials in the registry", async () => {
    const { directory, platform } = await harness();
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "Webmail",
      url: "https://mail.example.edu/SOGo/",
      enabled: true,
      auth: { operation: "set-password", username: "student", password: "app-password" },
    });
    const source = inventory.sources.find((entry) => entry.kind === "email")!;
    const connection = inventory.connections.find((entry) => entry.id === source.connectionId)!;
    expect(connection).toMatchObject({
      adapterId: "sogo",
      displayOrigin: "https://mail.example.edu",
      entryPath: "/SOGo/",
      allowedOrigins: ["https://mail.example.edu"],
    });
    expect(source.scope.tags).toEqual(["mail-provider:sogo"]);
    expect(
      await readFile(path.join(directory, "state", "study-buddy-sources.json"), "utf8"),
    ).not.toContain("app-password");
  });

  it("saves the provider's account email after a successful connection check", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("not used");
    };
    const webmailRuntime: StudyBuddyWebmailRuntime = {
      list: vi.fn(unavailable),
      read: vi.fn(unavailable),
      readContext: vi.fn(unavailable),
      test: vi.fn(async () => ({ senderEmail: "student@example.edu" })),
      sendExact: vi.fn(unavailable),
    };
    const { platform } = await harness({ webmailRuntime });
    let inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "University mail",
      url: "https://mail.example.edu/SOGo/",
      enabled: true,
      auth: { operation: "set-password", username: "student-login", password: "app-password" },
    });
    const source = inventory.sources.find((entry) => entry.kind === "email")!;

    await expect(platform.testSource({ sourceId: source.id })).resolves.toMatchObject({
      status: "success",
      code: "email-read-state-preserved",
    });

    inventory = await platform.getInventory();
    expect(inventory.sources.find((entry) => entry.id === source.id)?.health).toMatchObject({
      status: "connected",
      safeMessage: "Email is connected. Opening messages here keeps their read status unchanged.",
    });
    expect(
      inventory.connections.find((entry) => entry.id === source.connectionId)?.auth.emailAddress,
    ).toBe("student@example.edu");
  });

  it("persists simple read, draft, and ask-to-send permissions per email account", async () => {
    const { platform } = await harness();
    let inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "University mail",
      url: "https://mail.example.edu/SOGo/",
      enabled: true,
      auth: {
        operation: "set-password",
        username: "student-login",
        password: "app-password",
      },
    });
    const source = inventory.sources.find((entry) => entry.kind === "email")!;

    inventory = await platform.updateEmailPermissions({
      expectedRevision: inventory.revision,
      sourceId: source.id,
      read: false,
      draft: true,
      send: true,
      senderEmail: "student@example.edu",
    });
    const updated = inventory.sources.find((entry) => entry.id === source.id)!;
    const connection = inventory.connections.find((entry) => entry.id === source.connectionId)!;
    expect(updated.policy).toMatchObject({
      authenticatedReads: "denied",
      remoteDrafts: "allowed",
      emailSend: "approval-required",
    });
    expect(updated.capabilities).toEqual(["mail.draft.local", "mail.send"]);
    expect(connection.auth.emailAddress).toBe("student@example.edu");
    await expect(platform.email.listMessages({ sourceId: source.id })).rejects.toThrow(
      "Email reading is turned off",
    );
  });

  it("requires drafts and a sender address before send approval requests can be enabled", async () => {
    const { platform } = await harness();
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "University mail",
      url: "https://mail.example.edu/SOGo/",
      enabled: true,
      auth: { operation: "set-password", username: "student", password: "app-password" },
    });
    const source = inventory.sources.find((entry) => entry.kind === "email")!;

    await expect(
      platform.updateEmailPermissions({
        expectedRevision: inventory.revision,
        sourceId: source.id,
        read: true,
        draft: false,
        send: true,
        senderEmail: "student@example.edu",
      }),
    ).rejects.toThrow("Allow drafts");
    await expect(
      platform.updateEmailPermissions({
        expectedRevision: inventory.revision,
        sourceId: source.id,
        read: true,
        draft: true,
        send: true,
        senderEmail: null,
      }),
    ).rejects.toThrow("Enter the email address");
  });

  it("keeps send requests off when an account has no verified outgoing adapter", async () => {
    const { platform } = await harness();
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "email",
      label: "IMAP-only university mail",
      url: "imaps://mail.example.edu:993",
      enabled: true,
      auth: { operation: "set-password", username: "student", password: "app-password" },
    });
    const source = inventory.sources.find((entry) => entry.kind === "email")!;

    await expect(
      platform.updateEmailPermissions({
        expectedRevision: inventory.revision,
        sourceId: source.id,
        read: true,
        draft: true,
        send: true,
        senderEmail: "student@example.edu",
      }),
    ).rejects.toThrow("Sending is not available for this email service yet");
  });
});
