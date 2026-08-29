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

async function harness(
  options: {
    webmailRuntime?: StudyBuddyWebmailRuntime;
    sourceSecretKey?: string | null;
  } = {},
) {
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
    ...(options.sourceSecretKey === null
      ? {}
      : { sourceSecretKey: options.sourceSecretKey ?? Buffer.alloc(32, 7).toString("base64") }),
  } as ServerConfigShape;
  return {
    config,
    directory,
    secretStore: secrets,
    secretValues: values,
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
    expect(raw).not.toContain("old-user");
    expect(raw).not.toContain("old-password");
    expect(raw).not.toContain("new-user");
    expect(raw).not.toContain("new-password");
    expect(raw).toContain("MOODLE_DASHBOARD_URL=https://learn.example.edu/my/\n");
  });

  it("encrypts source usernames, passwords, and private calendar URLs at rest", async () => {
    const { directory, platform, secretValues } = await harness();
    const username = "source-user-canary@example.edu";
    const password = "source-password-canary";
    const calendarUrl = "https://calendar.example.edu/private-calendar-canary.ics";

    let inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "moodle-course",
      label: "Moodle",
      url: "https://moodle.example.edu/my/",
      enabled: true,
      auth: { operation: "set-password", username, password },
    });
    inventory = await platform.createSource({
      expectedRevision: inventory.revision,
      kind: "calendar",
      label: "Calendar",
      url: "https://calendar.example.edu",
      enabled: true,
      auth: { operation: "set-bearer-url", value: calendarUrl },
    });

    expect(inventory.connections.some((entry) => entry.auth.accountLabel === username)).toBe(true);
    const persisted = [
      await readFile(path.join(directory, "state", "study-buddy-sources.json"), "utf8"),
      ...Array.from(secretValues.values(), (value) => new TextDecoder().decode(value)),
    ].join("\n");
    expect(persisted).not.toContain(username);
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain(calendarUrl);
    expect(persisted).toContain('"algorithm":"aes-256-gcm"');
  });

  it("resolves encrypted Moodle credentials only inside the server workflow boundary", async () => {
    const { directory, platform, secretValues } = await harness();
    const username = "workflow-user-canary";
    const password = "workflow-password-canary";
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "moodle-course",
      label: "Deterministic Moodle",
      url: "https://moodle.example.edu/my/",
      enabled: true,
      auth: { operation: "set-password", username, password },
    });

    const environment = await platform.resolveWorkflowEnvironment({
      sourceIds: [inventory.sources[0]!.id],
    });

    expect(environment).toMatchObject({
      MOODLE_USERNAME: username,
      MOODLE_PASSWORD: password,
      MOODLE_DASHBOARD_URL: "https://moodle.example.edu/my/",
      MOODLE_BASE_URL: "https://moodle.example.edu",
      MOODLE_LOGIN_ALLOWED_ORIGINS: "https://moodle.example.edu",
    });
    const persisted = [
      await readFile(path.join(directory, "state", "study-buddy-sources.json"), "utf8"),
      ...Array.from(secretValues.values(), (value) => new TextDecoder().decode(value)),
    ].join("\n");
    expect(persisted).not.toContain(username);
    expect(persisted).not.toContain(password);
    expect(JSON.stringify(await platform.getInventory())).not.toContain(password);
  });

  it("migrates a legacy plaintext source secret only after verified encryption", async () => {
    const { platform, secretValues } = await harness();
    const username = "legacy-user-canary";
    const password = "legacy-password-canary";
    const inventory = await platform.createSource({
      expectedRevision: 0,
      kind: "moodle-course",
      label: "Moodle",
      url: "https://moodle.example.edu/my/",
      enabled: true,
      auth: { operation: "set-password", username, password },
    });
    const [encryptedSecretName] = secretValues.keys();
    expect(encryptedSecretName).toMatch(/-v2$/);
    const secretName = encryptedSecretName!.replace(/-v2$/, "");
    secretValues.delete(encryptedSecretName!);
    secretValues.set(
      secretName!,
      new TextEncoder().encode(JSON.stringify({ type: "password", username, password })),
    );

    const migrated = await platform.getInventory();
    expect(migrated.connections[0]?.auth.accountLabel).toBe(username);
    expect(secretValues.has(secretName)).toBe(false);
    const persisted = new TextDecoder().decode(secretValues.get(encryptedSecretName!)!);
    expect(persisted).toContain('"version":2');
    expect(persisted).not.toContain(username);
    expect(persisted).not.toContain(password);

    // A crash between verified encryption and legacy deletion is retry-safe.
    secretValues.set(
      secretName!,
      new TextEncoder().encode(JSON.stringify({ type: "password", username, password })),
    );
    await platform.getInventory();
    expect(secretValues.has(secretName)).toBe(false);
    expect(inventory.sources).toHaveLength(1);
  });

  it("fails closed when the desktop source-secret key is missing or malformed", async () => {
    const missing = await harness({ sourceSecretKey: null });
    const malformed = await harness({ sourceSecretKey: "not-a-valid-key" });
    const input = {
      expectedRevision: 0,
      kind: "moodle-course" as const,
      label: "Moodle",
      url: "https://moodle.example.edu/my/",
      enabled: true,
      auth: {
        operation: "set-password" as const,
        username: "student",
        password: "secret",
      },
    };

    await expect(missing.platform.createSource(input)).rejects.toThrow(
      "Secure source storage is unavailable",
    );
    await expect(malformed.platform.createSource(input)).rejects.toThrow("invalid key");
    expect(missing.secretValues.size).toBe(0);
    expect(malformed.secretValues.size).toBe(0);
  });

  it("allows only the current OS-backed key to decrypt persisted source credentials", async () => {
    const { config, platform, secretStore } = await harness();
    await platform.createSource({
      expectedRevision: 0,
      kind: "moodle-course",
      label: "Moodle",
      url: "https://moodle.example.edu/my/",
      enabled: true,
      auth: {
        operation: "set-password",
        username: "current-user-canary",
        password: "current-user-password-canary",
      },
    });
    const wrongUserPlatform = createStudyBuddySourcePlatform(
      { ...config, sourceSecretKey: Buffer.alloc(32, 8).toString("base64") },
      secretStore,
      { assertPublicNetworkHost: async () => undefined },
    );

    await expect(wrongUserPlatform.getInventory()).rejects.toThrow("could not be unlocked");
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
        sourceSecretKey: Buffer.alloc(32, 7).toString("base64"),
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
