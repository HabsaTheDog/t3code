// @effect-diagnostics nodeBuiltinImport:off -- Isolated filesystem fixtures for source persistence.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      assertPublicNetworkHost: async () => undefined,
      ...(options.webmailRuntime
        ? { emailBrokerDependencies: { webmailRuntime: options.webmailRuntime } }
        : {}),
    }),
  };
}

describe("Study Buddy source inventory", () => {
  it("starts fresh installations without preselected sources", async () => {
    const { platform } = await harness();

    await expect(platform.getInventory()).resolves.toMatchObject({
      revision: 0,
      connections: [],
      sources: [],
    });
  });

  it("removes untouched unconfigured placeholders left by the first alpha", async () => {
    const { directory, platform } = await harness();
    const stateDirectory = path.join(directory, "state");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      path.join(stateDirectory, "study-buddy-sources.json"),
      `${JSON.stringify({
        version: 1,
        revision: 3,
        connections: [
          {
            id: "legacy-calendar-connection",
            adapterId: "legacy-calendar",
            adapterVersion: "legacy-v1",
            label: "Personal calendar",
            displayOrigin: "https://calendar.invalid",
            entryPath: "",
            allowedOrigins: ["https://calendar.invalid"],
            auth: { mode: "bearer-url", state: "not-configured" },
            revision: 0,
          },
        ],
        sources: [
          {
            id: "legacy-calendar",
            label: "Personal calendar",
            kind: "calendar",
            enabled: true,
            connectionId: "legacy-calendar-connection",
            priority: 10,
            scope: {
              allowedOrigins: ["https://calendar.invalid"],
              pathPrefixes: [],
              courseIds: [],
              mailFolders: [],
              tags: ["legacy"],
            },
            capabilities: ["calendar.events.read"],
            policy: {
              authenticatedReads: "allowed",
              downloads: "allowed",
              remoteDrafts: "denied",
              emailSend: "denied",
            },
            health: { status: "unknown" },
            revision: 0,
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(platform.getInventory()).resolves.toMatchObject({
      revision: 3,
      connections: [],
      sources: [],
    });
  });

  it("allows users to keep adding sources without a fixed three-source limit", async () => {
    const { platform } = await harness();
    let inventory = await platform.getInventory();

    for (let index = 1; index <= 12; index += 1) {
      inventory = await platform.createSource({
        expectedRevision: inventory.revision,
        kind: "website",
        label: `Study website ${index}`,
        url: `https://source-${index}.example.edu/resources/`,
        enabled: true,
        auth: { operation: "set-none" },
      });
    }

    expect(inventory.sources).toHaveLength(12);
    expect(inventory.connections).toHaveLength(12);
    expect(inventory.revision).toBe(12);
  });

  it("replaces private calendar links without persisting their bearer path", async () => {
    const { directory, platform } = await harness();
    let inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "calendar",
      label: "University calendar",
      url: "https://calendar.example.edu/old-private-token.ics",
      enabled: true,
      auth: {
        operation: "set-bearer-url",
        value: "https://calendar.example.edu/old-private-token.ics",
      },
    });
    const calendar = inventory.sources[0]!;

    inventory = await platform.setSourceAuth({
      operation: "set-bearer-url",
      expectedRevision: inventory.revision,
      sourceId: calendar.id,
      value: "https://new-calendar.example.edu/new-private-token.ics",
    });

    expect(inventory.connections[0]?.displayOrigin).toBe("https://new-calendar.example.edu");
    expect(inventory.sources[0]?.scope.allowedOrigins).toEqual([
      "https://new-calendar.example.edu",
    ]);
    const registry = await readFile(
      path.join(directory, "state", "study-buddy-sources.json"),
      "utf8",
    );
    expect(registry).not.toContain("old-private-token");
    expect(registry).not.toContain("new-private-token");
  });

  it("keeps configured legacy sources editable during the alpha migration", async () => {
    const { directory, platform } = await harness();
    await writeFile(
      path.join(directory, ".env.local"),
      "MOODLE_USERNAME=old-user\nMOODLE_PASSWORD=old-password\n",
      "utf8",
    );
    let inventory = await platform.getInventory();
    const moodle = inventory.sources.find((source) => source.id === "legacy-moodle")!;

    inventory = await platform.updateSource({
      expectedRevision: inventory.revision,
      sourceId: moodle.id,
      label: "My Moodle",
      url: "https://learn.example.edu/my/",
    });
    inventory = await platform.setSourceAuth({
      operation: "set-password",
      expectedRevision: inventory.revision,
      sourceId: moodle.id,
      username: "new-user",
      password: "new-password",
    });

    expect(inventory.sources.find((source) => source.id === moodle.id)?.label).toBe("My Moodle");
    const raw = await readFile(path.join(directory, ".env.local"), "utf8");
    expect(raw).toContain("MOODLE_USERNAME=new-user\n");
    expect(raw).toContain("MOODLE_PASSWORD=new-password\n");
    expect(raw).toContain("MOODLE_DASHBOARD_URL=https://learn.example.edu/my/\n");
  });
});

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

  it("rejects IMAPS endpoints that fail the public-network policy", async () => {
    const { platform } = await harness();
    const guardedPlatform = createStudyBuddySourcePlatform(
      {
        cwd: "/tmp",
        stateDir: path.join(temporaryDirectories.at(-1)!, "guarded-state"),
        secretsDir: path.join(temporaryDirectories.at(-1)!, "guarded-secrets"),
      } as ServerConfigShape,
      {
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        remove: () => Effect.void,
      },
      {
        assertPublicNetworkHost: async () => {
          throw new Error("URL resolves to a local or private network address.");
        },
      },
    );
    void platform;

    await expect(
      guardedPlatform.createSource({
        expectedRevision: 0,
        kind: "email",
        label: "Unsafe IMAP",
        url: "imaps://127.0.0.1:993",
        enabled: true,
        auth: { operation: "set-password", username: "student", password: "secret" },
      }),
    ).rejects.toThrow("local or private network address");
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
