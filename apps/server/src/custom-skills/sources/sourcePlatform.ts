// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StudyBuddyCreateSourceInput,
  StudyBuddyDeleteSourceInput,
  StudyBuddySetSourceAuthInput,
  StudyBuddySourceAdapterDescriptor,
  StudyBuddySourceBlock,
  StudyBuddySourceCapability,
  StudyBuddySourceConnection,
  StudyBuddySourceInventory,
  StudyBuddySourceKind,
  StudyBuddySourceTestResult,
  StudyBuddyTestSourceInput,
  StudyBuddyUpdateEmailPermissionsInput,
  StudyBuddyUpdateSourceInput,
} from "@t3tools/contracts";
import {
  StudyBuddySourceBlock as StudyBuddySourceBlockSchema,
  StudyBuddySourceConnection as StudyBuddySourceConnectionSchema,
  StudyBuddySourceError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";
import type { ServerSecretStoreShape } from "../../auth/ServerSecretStore.ts";
import type { ServerConfigShape } from "../../config.ts";
import { createBrowserLoginConfig, ensureLoggedIn } from "../moodle/browserAuth.ts";
import { assertPublicHttpsUrl, assertPublicNetworkHostname } from "../moodle/browserSecurity.ts";
import {
  fetchCalendarText,
  normalizeCalendarUrl,
  validateCalendarText,
} from "../moodle/calendarConnection.ts";
import {
  clearLegacyStudyBuddySourceCredentials,
  readStoredStudyBuddyConfiguration,
  updateStudyBuddyConfiguration,
} from "../moodle/studyBuddyConfig.ts";
import {
  createStudyBuddyEmailReadBroker,
  type StudyBuddyEmailAccess,
  type StudyBuddyEmailBrokerDependencies,
  type StudyBuddyEmailReadBroker,
} from "./emailReadBroker.ts";
import {
  discoverStudyBuddyWebmailProvider,
  type StudyBuddyWebmailDiscoveryResult,
} from "./webmailDiscovery.ts";
import {
  getSourceSecret as getSecret,
  removeSourceSecret as removeSecret,
  setSourceSecret as setSecret,
  type SourceSecret,
} from "./sourceSecretStorage.ts";

interface StoredSourceDocument {
  readonly version: 1;
  readonly revision: number;
  readonly connections: readonly StudyBuddySourceConnection[];
  readonly sources: readonly StudyBuddySourceBlock[];
}

const isStudyBuddySourceError = Schema.is(StudyBuddySourceError);
const StoredSourceDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  connections: Schema.Array(StudyBuddySourceConnectionSchema),
  sources: Schema.Array(StudyBuddySourceBlockSchema),
});
const decodeStoredSourceDocument = Schema.decodeUnknownSync(StoredSourceDocumentSchema);

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

const ADAPTERS: readonly StudyBuddySourceAdapterDescriptor[] = [
  {
    id: "moodle",
    kind: "moodle-course",
    label: "Moodle course",
    description: "Course structure, learning material, files, and completed quiz evidence.",
    supportedAuthModes: ["password", "interactive-session"],
    defaultCapabilities: [
      "content.search",
      "content.list",
      "content.read",
      "content.download",
      "course.structure.read",
      "quiz.completed-attempt.read",
    ],
    availability: "available",
  },
  {
    id: "ical",
    kind: "calendar",
    label: "Calendar",
    description: "Upcoming classes, exams, rooms, and deadlines from a private calendar feed.",
    supportedAuthModes: ["bearer-url"],
    defaultCapabilities: ["calendar.events.read"],
    availability: "available",
  },
  {
    id: "generic-website",
    kind: "website",
    label: "Website",
    description: "A bounded public or signed-in website used as study evidence.",
    supportedAuthModes: ["none", "password", "interactive-session"],
    defaultCapabilities: ["content.search", "content.list", "content.read", "content.download"],
    availability: "available",
  },
  {
    id: "resource-portal",
    kind: "resource-portal",
    label: "Resource portal",
    description: "Books, readings, and other study resources from a bounded portal.",
    supportedAuthModes: ["none", "password", "interactive-session"],
    defaultCapabilities: ["content.search", "content.list", "content.read", "content.download"],
    availability: "available",
  },
  {
    id: "imap",
    kind: "email",
    label: "University email",
    description: "Read messages without changing their read or unread state.",
    supportedAuthModes: ["password"],
    defaultCapabilities: ["mail.threads.list", "mail.message.read"],
    availability: "available",
  },
];

export interface StudyBuddySourcePlatform {
  readonly email: StudyBuddyEmailReadBroker;
  getInventory(): Promise<StudyBuddySourceInventory>;
  createSource(input: StudyBuddyCreateSourceInput): Promise<StudyBuddySourceInventory>;
  updateSource(input: StudyBuddyUpdateSourceInput): Promise<StudyBuddySourceInventory>;
  deleteSource(input: StudyBuddyDeleteSourceInput): Promise<StudyBuddySourceInventory>;
  setSourceAuth(input: StudyBuddySetSourceAuthInput): Promise<StudyBuddySourceInventory>;
  updateEmailPermissions(
    input: StudyBuddyUpdateEmailPermissionsInput,
  ): Promise<StudyBuddySourceInventory>;
  testSource(input: StudyBuddyTestSourceInput): Promise<StudyBuddySourceTestResult>;
}

export interface StudyBuddySourcePlatformDependencies {
  readonly discoverWebmailProvider?: (url: string) => Promise<StudyBuddyWebmailDiscoveryResult>;
  readonly emailBrokerDependencies?: StudyBuddyEmailBrokerDependencies;
  readonly assertPublicNetworkHost?: (hostname: string) => Promise<void>;
}

export function createStudyBuddySourcePlatform(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
  dependencies: StudyBuddySourcePlatformDependencies = {},
): StudyBuddySourcePlatform {
  const registryPath = path.join(config.stateDir, "study-buddy-sources.json");
  const discoverWebmailProvider =
    dependencies.discoverWebmailProvider ?? discoverStudyBuddyWebmailProvider;
  const assertPublicNetworkHost =
    dependencies.assertPublicNetworkHost ?? assertPublicNetworkHostname;
  let mutationQueue: Promise<void> = Promise.resolve();

  const withMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const getInventory = async (): Promise<StudyBuddySourceInventory> =>
    publicInventory(config, await materializedDocument(config, registryPath, secrets), secrets);

  const resolveEmailAccess = async (
    sourceId: string,
    purpose: "read" | "test" | "send",
  ): Promise<StudyBuddyEmailAccess> => {
    const document = await materializedDocument(config, registryPath, secrets);
    const source = document.sources.find((entry) => entry.id === sourceId);
    if (!source) throw sourceError("not-found", "Email source was not found.");
    if (source.kind !== "email") throw sourceError("invalid", "Source is not an email source.");
    if (!source.enabled) throw sourceError("unavailable", "Email source is disabled.");
    if (
      purpose === "read" &&
      (source.policy.authenticatedReads !== "allowed" ||
        !source.capabilities.includes("mail.message.read"))
    ) {
      throw sourceError(
        "unavailable",
        "Email reading is turned off for this source. Open its settings to allow it.",
      );
    }
    if (
      purpose === "send" &&
      (source.policy.emailSend !== "approval-required" ||
        source.policy.remoteDrafts !== "allowed" ||
        !source.capabilities.includes("mail.send"))
    ) {
      throw sourceError(
        "unavailable",
        "Email sending is turned off for this source. Open its settings to allow approval requests.",
      );
    }
    const connection = document.connections.find((entry) => entry.id === source.connectionId);
    if (!connection) throw sourceError("internal", "Email source connection is missing.");
    const secret = await getSecret(config, secrets, connection.id);
    if (secret?.type !== "password") {
      throw sourceError("unavailable", "Email sign-in details are not configured.");
    }
    const target = `${connection.displayOrigin}${connection.entryPath || "/"}`;
    if (connection.displayOrigin.startsWith("imaps://")) {
      const endpoint = validateEmailImapUrl(target);
      await assertPublicNetworkHost(endpoint.hostname);
      return {
        transport: "imap",
        sourceId,
        host: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : 993,
        secure: true,
        username: secret.username,
        password: secret.password,
        ...(secret.emailAddress ? { senderEmail: secret.emailAddress } : {}),
        folders: source.scope.mailFolders.length > 0 ? source.scope.mailFolders : ["INBOX"],
      };
    }
    const endpoint = validateEmailSourceUrl(target);
    return {
      transport: "webmail",
      sourceId,
      profileId: connection.adapterId,
      baseUrl: endpoint.href,
      username: secret.username,
      password: secret.password,
      ...(secret.emailAddress ? { senderEmail: secret.emailAddress } : {}),
      folders: source.scope.mailFolders.length > 0 ? source.scope.mailFolders : ["INBOX"],
    };
  };

  const email = createStudyBuddyEmailReadBroker(
    resolveEmailAccess,
    dependencies.emailBrokerDependencies,
  );

  const createSource = (input: StudyBuddyCreateSourceInput) =>
    withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      assertRevision(document, input.expectedRevision);
      const descriptor = adapterForKind(input.kind);
      const parsed = validatePublicSourceUrl(input.url, input.kind, input.auth.operation);
      if (parsed.protocol === "imaps:") await assertPublicNetworkHost(parsed.hostname);
      const webmail =
        input.kind === "email" && parsed.protocol === "https:"
          ? await discoverWebmailProvider(parsed.href)
          : undefined;
      const resolvedUrl = webmail ? new URL(webmail.baseUrl) : parsed;
      const allowedOrigins = webmail?.allowedOrigins ?? [displayOriginFor(resolvedUrl, input.kind)];
      const suffix = randomUUID();
      const sourceId = `source-${suffix}`;
      const connectionId = `connection-${suffix}`;
      const auth = storedAuth(publicAuthForCreate(input.auth));
      const connection: StudyBuddySourceConnection = {
        id: connectionId,
        adapterId: webmail?.profile.id ?? descriptor.id,
        adapterVersion: "1",
        label: input.label,
        displayOrigin: displayOriginFor(resolvedUrl, input.kind),
        entryPath: entryPathFor(resolvedUrl, input.kind),
        allowedOrigins: [...allowedOrigins],
        auth,
        revision: 0,
      };
      const source: StudyBuddySourceBlock = {
        id: sourceId,
        label: input.label,
        kind: input.kind,
        enabled: input.enabled,
        connectionId,
        priority: defaultPriority(input.kind),
        scope: {
          allowedOrigins: [...allowedOrigins],
          pathPrefixes:
            input.kind === "calendar" || input.kind === "email"
              ? []
              : [pathPrefix(parsed.pathname)],
          courseIds: [],
          mailFolders: input.kind === "email" ? ["INBOX"] : [],
          tags: webmail ? [`mail-provider:${webmail.profile.id}`] : [],
        },
        capabilities: [...descriptor.defaultCapabilities],
        policy: {
          authenticatedReads: "allowed",
          downloads: input.kind === "calendar" || input.kind === "email" ? "denied" : "allowed",
          remoteDrafts: "denied",
          emailSend: "denied",
        },
        health: { status: "unknown" },
        revision: 0,
      };
      const secret = secretFromCreate(input.auth);
      if (secret) await setSecret(config, secrets, connectionId, secret);
      const next: StoredSourceDocument = {
        ...document,
        revision: document.revision + 1,
        connections: [...document.connections, connection],
        sources: [...document.sources, source],
      };
      try {
        await writeDocument(registryPath, next);
      } catch (error) {
        if (secret) await removeSecret(secrets, connectionId).catch(() => undefined);
        throw error;
      }
      return publicInventory(config, next, secrets);
    }).catch(mapSourceError);

  const updateSource = (input: StudyBuddyUpdateSourceInput) =>
    withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      assertRevision(document, input.expectedRevision);
      const index = document.sources.findIndex((source) => source.id === input.sourceId);
      if (index < 0) throw sourceError("not-found", "Source was not found.");
      const source = document.sources[index]!;
      const connectionIndex = document.connections.findIndex(
        (entry) => entry.id === source.connectionId,
      );
      if (connectionIndex < 0) throw sourceError("internal", "Source connection is missing.");
      const connection = document.connections[connectionIndex]!;
      let nextConnection = connection;
      if (input.url !== undefined) {
        if (source.kind === "calendar") {
          throw sourceError("invalid", "Replace a private calendar link through its secret field.");
        }
        const parsed = validatePublicSourceUrl(input.url, source.kind);
        if (parsed.protocol === "imaps:") await assertPublicNetworkHost(parsed.hostname);
        const webmail =
          source.kind === "email" && parsed.protocol === "https:"
            ? await discoverWebmailProvider(parsed.href)
            : undefined;
        const resolvedUrl = webmail ? new URL(webmail.baseUrl) : parsed;
        const allowedOrigins = webmail?.allowedOrigins ?? [
          displayOriginFor(resolvedUrl, source.kind),
        ];
        nextConnection = {
          ...connection,
          adapterId: webmail?.profile.id ?? adapterForKind(source.kind).id,
          displayOrigin: displayOriginFor(resolvedUrl, source.kind),
          entryPath: entryPathFor(resolvedUrl, source.kind),
          allowedOrigins: [...allowedOrigins],
          revision: connection.revision + 1,
        };
        const legacyTarget = legacyTargetFor(source.id);
        if (legacyTarget === "moodle") {
          await Effect.runPromise(
            updateStudyBuddyConfiguration(config, { moodleDashboardUrl: input.url }, secrets),
          );
        } else if (legacyTarget === "cis") {
          await Effect.runPromise(
            updateStudyBuddyConfiguration(config, { cisUrl: input.url }, secrets),
          );
        }
      }
      if (input.label !== undefined) nextConnection = { ...nextConnection, label: input.label };
      const nextSource: StudyBuddySourceBlock = {
        ...source,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.url !== undefined
          ? {
              scope: {
                ...source.scope,
                allowedOrigins: [...nextConnection.allowedOrigins],
                pathPrefixes:
                  source.kind === "email" ? [] : [pathPrefix(new URL(input.url).pathname)],
                tags:
                  source.kind === "email" && nextConnection.adapterId !== "imap"
                    ? [`mail-provider:${nextConnection.adapterId}`]
                    : source.scope.tags.filter((tag) => !tag.startsWith("mail-provider:")),
              },
            }
          : {}),
        health: input.url !== undefined ? { status: "unknown" } : source.health,
        revision: source.revision + 1,
      };
      const connections = [...document.connections];
      connections[connectionIndex] = nextConnection;
      const sources = [...document.sources];
      sources[index] = nextSource;
      const next = { ...document, revision: document.revision + 1, connections, sources };
      await writeDocument(registryPath, next);
      return publicInventory(config, next, secrets);
    }).catch(mapSourceError);

  const deleteSource = (input: StudyBuddyDeleteSourceInput) =>
    withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      assertRevision(document, input.expectedRevision);
      const source = document.sources.find((entry) => entry.id === input.sourceId);
      if (!source) throw sourceError("not-found", "Source was not found.");
      const remainingSources = document.sources.filter((entry) => entry.id !== input.sourceId);
      const connectionStillUsed = remainingSources.some(
        (entry) => entry.connectionId === source.connectionId,
      );
      const next: StoredSourceDocument = {
        ...document,
        revision: document.revision + 1,
        sources: remainingSources,
        connections: connectionStillUsed
          ? document.connections
          : document.connections.filter((entry) => entry.id !== source.connectionId),
      };
      await writeDocument(registryPath, next);
      if (!connectionStillUsed) {
        await removeSecret(secrets, source.connectionId);
      }
      return publicInventory(config, next, secrets);
    }).catch(mapSourceError);

  const setSourceAuth = (input: StudyBuddySetSourceAuthInput) =>
    withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      assertRevision(document, input.expectedRevision);
      const source = document.sources.find((entry) => entry.id === input.sourceId);
      if (!source) throw sourceError("not-found", "Source was not found.");
      const connectionIndex = document.connections.findIndex(
        (entry) => entry.id === source.connectionId,
      );
      if (connectionIndex < 0) throw sourceError("internal", "Source connection is missing.");
      const connection = document.connections[connectionIndex]!;
      let auth: StudyBuddySourceConnection["auth"];
      let displayOrigin = connection.displayOrigin;
      let allowedOrigins = connection.allowedOrigins;
      if (input.operation === "clear") {
        await removeSecret(secrets, connection.id);
        auth = { mode: connection.auth.mode, state: "not-configured" };
      } else if (input.operation === "set-password") {
        await setSecret(config, secrets, connection.id, {
          type: "password",
          username: input.username,
          password: input.password,
          ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}),
        });
        auth = storedAuth({
          mode: "password",
          state: "configured",
          accountLabel: input.username,
          ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}),
        });
      } else {
        const parsed = validatePrivateBearerUrl(input.value);
        await setSecret(config, secrets, connection.id, {
          type: "bearer-url",
          value: input.value,
        });
        auth = { mode: "bearer-url", state: "configured" };
        displayOrigin = parsed.origin;
        allowedOrigins = [parsed.origin];
      }
      const connections = [...document.connections];
      connections[connectionIndex] = {
        ...connection,
        displayOrigin,
        allowedOrigins,
        auth,
        revision: connection.revision + 1,
      };
      const sources = document.sources.map((entry) =>
        entry.id === source.id
          ? {
              ...entry,
              ...(input.operation === "set-bearer-url"
                ? { scope: { ...entry.scope, allowedOrigins } }
                : {}),
              health: { status: "unknown" as const },
              revision: entry.revision + 1,
            }
          : entry,
      );
      const next = { ...document, revision: document.revision + 1, connections, sources };
      await writeDocument(registryPath, next);
      return publicInventory(config, next, secrets);
    }).catch(mapSourceError);

  const updateEmailPermissions = (input: StudyBuddyUpdateEmailPermissionsInput) =>
    withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      assertRevision(document, input.expectedRevision);
      const sourceIndex = document.sources.findIndex((entry) => entry.id === input.sourceId);
      if (sourceIndex < 0) throw sourceError("not-found", "Email source was not found.");
      const source = document.sources[sourceIndex]!;
      if (source.kind !== "email") throw sourceError("invalid", "Source is not an email source.");
      if (input.send && !input.draft) {
        throw sourceError("invalid", "Allow drafts before allowing send requests.");
      }
      if (input.send && !input.senderEmail) {
        throw sourceError("invalid", "Enter the email address messages will be sent from.");
      }
      const connectionIndex = document.connections.findIndex(
        (entry) => entry.id === source.connectionId,
      );
      if (connectionIndex < 0) throw sourceError("internal", "Email source connection is missing.");
      const emailConnection = document.connections[connectionIndex]!;
      if (input.send && !["sogo", "roundcube"].includes(emailConnection.adapterId)) {
        throw sourceError(
          "unavailable",
          "Sending is not available for this email service yet. Reading and drafts still work.",
        );
      }

      const unrelated = source.capabilities.filter((capability) => !capability.startsWith("mail."));
      const capabilities: StudyBuddySourceCapability[] = [
        ...unrelated,
        ...(input.read
          ? (["mail.threads.list", "mail.message.read"] as StudyBuddySourceCapability[])
          : []),
        ...(input.draft ? (["mail.draft.local"] as StudyBuddySourceCapability[]) : []),
        ...(input.send ? (["mail.send"] as StudyBuddySourceCapability[]) : []),
      ];
      const sources = [...document.sources];
      sources[sourceIndex] = {
        ...source,
        capabilities,
        policy: {
          ...source.policy,
          authenticatedReads: input.read ? "allowed" : "denied",
          remoteDrafts: input.draft ? "allowed" : "denied",
          emailSend: input.send ? "approval-required" : "denied",
        },
        revision: source.revision + 1,
      };
      const connections = [...document.connections];
      const connection = connections[connectionIndex]!;
      const { emailAddress: _previousEmailAddress, ...authWithoutEmailAddress } = connection.auth;
      connections[connectionIndex] = {
        ...connection,
        auth: input.senderEmail
          ? { ...connection.auth, emailAddress: input.senderEmail }
          : authWithoutEmailAddress,
        revision: connection.revision + 1,
      };
      const next = { ...document, revision: document.revision + 1, sources, connections };
      await writeDocument(registryPath, next);
      return publicInventory(config, next, secrets);
    }).catch(mapSourceError);

  const testSourceOnce = async (
    input: StudyBuddyTestSourceInput,
  ): Promise<StudyBuddySourceTestResult> => {
    try {
      const document = await materializedDocument(config, registryPath, secrets);
      const source = document.sources.find((entry) => entry.id === input.sourceId);
      if (!source) throw sourceError("not-found", "Source was not found.");
      const connection = document.connections.find((entry) => entry.id === source.connectionId);
      if (!connection) throw sourceError("internal", "Source connection is missing.");
      const checkedAt = nowIso();
      const legacyTarget = legacyTargetFor(source.id);
      if (connection.auth.mode === "interactive-session" || connection.auth.mode === "oauth") {
        return {
          sourceId: source.id,
          status: "action-required",
          code: "secure-sign-in-required",
          message: "Open secure sign-in to finish connecting this source.",
          checkedAt,
        };
      }
      if (source.kind === "calendar") {
        const secret = await getSecret(config, secrets, connection.id);
        if (secret?.type !== "bearer-url") {
          return failure(source.id, "not-configured", "Private calendar link is not configured.");
        }
        const text = await fetchCalendarText(normalizeCalendarUrl(secret.value));
        validateCalendarText(text);
        return success(source.id, "Calendar is connected.");
      }
      if (source.kind === "email") {
        const account = await email.testConnection(source.id);
        if (account.senderEmail && connection.auth.emailAddress !== account.senderEmail) {
          await rememberEmailAddress(source.id, account.senderEmail);
        }
        return success(
          source.id,
          "Email is connected. Opening messages here keeps their read status unchanged.",
          "email-read-state-preserved",
        );
      }
      const targetUrl = `${connection.displayOrigin}${connection.entryPath || "/"}`;
      if (connection.auth.mode === "none") {
        await safeWebsiteProbe(targetUrl);
        return success(source.id, "Website is connected.");
      }
      const secret = await getSecret(config, secrets, connection.id);
      if (secret?.type !== "password") {
        return failure(
          source.id,
          "credentials-not-configured",
          "Sign-in details are not configured.",
        );
      }
      const browser = await chromium.launch({ headless: true });
      try {
        const page =
          legacyTarget === "cis"
            ? await browser.newPage({
                httpCredentials: { username: secret.username, password: secret.password },
              })
            : await browser.newPage();
        await ensureLoggedIn(
          page,
          createBrowserLoginConfig({
            serviceName: source.label,
            targetUrl,
            username: secret.username,
            password: secret.password,
            allowedOrigins: connection.allowedOrigins,
            requireCredentialSubmission: legacyTarget !== "cis",
          }),
        );
      } finally {
        await browser.close();
      }
      return success(source.id, "Sign-in worked. This source is connected.");
    } catch (error) {
      if (isStudyBuddySourceError(error)) throw error;
      return failure(input.sourceId, "connection-failed", safeErrorMessage(error));
    }
  };

  const testSource = async (
    input: StudyBuddyTestSourceInput,
  ): Promise<StudyBuddySourceTestResult> => {
    const result = await testSourceOnce(input);
    await rememberSourceHealth(input.sourceId, result);
    return result;
  };

  return {
    email,
    getInventory,
    createSource,
    updateSource,
    deleteSource,
    setSourceAuth,
    updateEmailPermissions,
    testSource,
  };

  async function rememberEmailAddress(sourceId: string, emailAddress: string): Promise<void> {
    await withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      const source = document.sources.find((entry) => entry.id === sourceId);
      if (!source) return;
      const connectionIndex = document.connections.findIndex(
        (entry) => entry.id === source.connectionId,
      );
      if (connectionIndex < 0) return;
      const connection = document.connections[connectionIndex]!;
      const secret = await getSecret(config, secrets, connection.id);
      if (secret?.type !== "password" || secret.emailAddress === emailAddress) return;
      await setSecret(config, secrets, connection.id, { ...secret, emailAddress });
      await writeDocument(registryPath, {
        ...document,
        revision: document.revision + 1,
        connections: document.connections.map((entry) =>
          entry.id === connection.id ? { ...entry, revision: entry.revision + 1 } : entry,
        ),
      });
    });
  }

  async function rememberSourceHealth(
    sourceId: string,
    result: StudyBuddySourceTestResult,
  ): Promise<void> {
    await withMutation(async () => {
      const document = await materializedDocument(config, registryPath, secrets);
      const sourceIndex = document.sources.findIndex((entry) => entry.id === sourceId);
      if (sourceIndex < 0) return;
      const source = document.sources[sourceIndex]!;
      const sources = [...document.sources];
      sources[sourceIndex] = {
        ...source,
        health: {
          status:
            result.status === "success"
              ? "connected"
              : result.status === "action-required"
                ? "action-required"
                : "failed",
          checkedAt: result.checkedAt,
          safeMessage: result.message,
        },
        revision: source.revision + 1,
      };
      await writeDocument(registryPath, {
        ...document,
        revision: document.revision + 1,
        sources,
      });
    });
  }
}

async function readDocument(
  config: ServerConfigShape,
  registryPath: string,
  secrets: ServerSecretStoreShape,
): Promise<StoredSourceDocument> {
  try {
    return withoutUnconfiguredLegacyPlaceholders(
      validateStoredDocument(JSON.parse(await readFile(registryPath, "utf8"))),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return projectLegacySources(config, secrets);
    if (error instanceof SyntaxError) throw sourceError("internal", "Source registry is invalid.");
    throw error;
  }
}

async function materializedDocument(
  config: ServerConfigShape,
  registryPath: string,
  secrets: ServerSecretStoreShape,
): Promise<StoredSourceDocument> {
  const document = await readDocument(config, registryPath, secrets);
  const legacyConfiguration = document.sources.some((source) =>
    source.scope.tags.includes("legacy"),
  )
    ? await readStoredStudyBuddyConfiguration(config, secrets)
    : null;
  // Reading each configured secret performs the one-time, verified migration
  // from the legacy plaintext file format before any caller sees the inventory.
  await Promise.all(
    document.connections
      .filter((connection) => connection.auth.mode !== "none")
      .map(async (connection) => {
        let secret = await getSecret(config, secrets, connection.id);
        if (!secret && legacyConfiguration) {
          const legacy = legacySecretFor(connection.id, legacyConfiguration.values);
          if (legacy) {
            await setSecret(config, secrets, connection.id, legacy);
            secret = await getSecret(config, secrets, connection.id);
            if (!secret || JSON.stringify(secret) !== JSON.stringify(legacy)) {
              throw sourceError("internal", "Legacy source credential migration failed.");
            }
          }
        }
        if (secret?.type === "password" && connection.auth.emailAddress && !secret.emailAddress) {
          await setSecret(config, secrets, connection.id, {
            ...secret,
            emailAddress: connection.auth.emailAddress,
          });
        }
      }),
  );
  const sanitized = sanitizeStoredAuthMetadata(document);
  if (sanitized !== document || legacyConfiguration) await writeDocument(registryPath, sanitized);
  if (legacyConfiguration) {
    await clearLegacyStudyBuddySourceCredentials(legacyConfiguration);
  }
  return sanitized;
}

async function projectLegacySources(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
): Promise<StoredSourceDocument> {
  const stored = await readStoredStudyBuddyConfiguration(config, secrets);
  const connections: StudyBuddySourceConnection[] = [];
  const sources: StudyBuddySourceBlock[] = [];
  const add = (input: {
    id: string;
    kind: StudyBuddySourceKind;
    label: string;
    url: string;
    configured: boolean;
    adapterId: string;
    capabilities: StudyBuddySourceCapability[];
    authMode: StudyBuddySourceConnection["auth"]["mode"];
  }) => {
    if (!input.configured) return;
    const parsed = publicLegacyUrl(input.url);
    const connectionId = `${input.id}-connection`;
    connections.push({
      id: connectionId,
      adapterId: input.adapterId,
      adapterVersion: "legacy-v1",
      label: input.label,
      displayOrigin: parsed.origin,
      entryPath: input.kind === "calendar" ? "" : `${parsed.pathname}${parsed.search}`,
      allowedOrigins: [parsed.origin],
      auth: {
        mode: input.authMode,
        state: input.configured ? "configured" : "not-configured",
      },
      revision: 0,
    });
    sources.push({
      id: input.id,
      label: input.label,
      kind: input.kind,
      enabled: true,
      connectionId,
      priority: defaultPriority(input.kind),
      scope: {
        allowedOrigins: [parsed.origin],
        pathPrefixes: input.kind === "calendar" ? [] : [pathPrefix(parsed.pathname)],
        courseIds: [],
        mailFolders: [],
        tags: ["legacy"],
      },
      capabilities: input.capabilities,
      policy: {
        authenticatedReads: "allowed",
        downloads: "allowed",
        remoteDrafts: "denied",
        emailSend: "denied",
      },
      health: { status: "unknown" },
      revision: 0,
    });
  };
  add({
    id: "legacy-moodle",
    kind: "moodle-course",
    label: "Moodle",
    url: stored.values.MOODLE_DASHBOARD_URL || "https://moodle.technikum-wien.at/my/",
    configured: Boolean(stored.values.MOODLE_PASSWORD),
    adapterId: "legacy-moodle",
    capabilities: adapterForKind("moodle-course").defaultCapabilities.slice(),
    authMode: "password",
  });
  add({
    id: "legacy-cis",
    kind: "website",
    label: "CIS student portal",
    url: firstUrl(stored.values.CIS_URLS) || "https://cis.technikum-wien.at/cis.php/",
    configured: Boolean(stored.values.CIS_PASSWORD || stored.values.MOODLE_PASSWORD),
    adapterId: "legacy-cis",
    capabilities: ["content.search", "content.list", "content.read", "calendar.events.read"],
    authMode: "password",
  });
  add({
    id: "legacy-calendar",
    kind: "calendar",
    label: "Personal calendar",
    url: stored.values.CIS_CALENDAR_URL || "https://calendar.invalid",
    configured: Boolean(stored.values.CIS_CALENDAR_URL),
    adapterId: "legacy-calendar",
    capabilities: ["calendar.events.read"],
    authMode: "bearer-url",
  });
  return { version: 1, revision: 0, connections, sources };
}

function withoutUnconfiguredLegacyPlaceholders(
  document: StoredSourceDocument,
): StoredSourceDocument {
  const placeholderIds = new Set(
    document.sources
      .filter((source) => {
        if (!source.scope.tags.includes("legacy")) return false;
        const connection = document.connections.find((entry) => entry.id === source.connectionId);
        if (!connection || connection.auth.state !== "not-configured") return false;
        return (
          (source.id === "legacy-moodle" &&
            source.label === "Moodle" &&
            connection.displayOrigin === "https://moodle.technikum-wien.at") ||
          (source.id === "legacy-cis" &&
            source.label === "CIS student portal" &&
            connection.displayOrigin === "https://cis.technikum-wien.at") ||
          (source.id === "legacy-calendar" &&
            source.label === "Personal calendar" &&
            connection.displayOrigin === "https://calendar.invalid")
        );
      })
      .map((source) => source.id),
  );
  if (placeholderIds.size === 0) return document;
  const sources = document.sources.filter((source) => !placeholderIds.has(source.id));
  const connectionIds = new Set(sources.map((source) => source.connectionId));
  return {
    ...document,
    sources,
    connections: document.connections.filter((connection) => connectionIds.has(connection.id)),
  };
}

async function publicInventory(
  config: ServerConfigShape,
  document: StoredSourceDocument,
  secrets: ServerSecretStoreShape,
): Promise<StudyBuddySourceInventory> {
  const connections = await Promise.all(
    document.connections.map(async (connection) => {
      if (connection.auth.mode === "none") return connection;
      const configured = Boolean(await getSecret(config, secrets, connection.id));
      const secret = configured ? await getSecret(config, secrets, connection.id) : null;
      return {
        ...connection,
        auth: {
          ...connection.auth,
          state: configured ? ("configured" as const) : connection.auth.state,
          ...(secret?.type === "password" ? { accountLabel: secret.username } : {}),
          ...(secret?.type === "password" && secret.emailAddress
            ? { emailAddress: secret.emailAddress }
            : {}),
        },
      };
    }),
  );
  return {
    version: 1,
    revision: document.revision,
    adapters: ADAPTERS.slice(),
    connections,
    sources: document.sources,
  };
}

function validateStoredDocument(value: unknown): StoredSourceDocument {
  try {
    return decodeStoredSourceDocument(value);
  } catch {
    throw sourceError("internal", "Source registry is invalid.");
  }
}

async function writeDocument(filePath: string, document: StoredSourceDocument): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

function validatePublicSourceUrl(
  value: string,
  kind: StudyBuddySourceKind,
  authOperation?: StudyBuddyCreateSourceInput["auth"]["operation"],
): URL {
  if (kind === "calendar") {
    if (authOperation !== "set-bearer-url") {
      throw sourceError("invalid", "Calendar sources require a private calendar link.");
    }
    return validatePrivateBearerUrl(value);
  }
  if (kind === "email") {
    if (authOperation !== undefined && authOperation !== "set-password") {
      throw sourceError("invalid", "Email sources require username and password sign-in.");
    }
    return validateEmailSourceUrl(value);
  }
  const parsed = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some(isCredentialParameter)
  ) {
    throw sourceError("invalid", "Source URLs require HTTPS without embedded credentials.");
  }
  return parsed;
}

function validateEmailImapUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw sourceError("invalid", "Email sources require a valid imaps://host[:port] URL.");
  }
  if (
    parsed.protocol !== "imaps:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw sourceError(
      "invalid",
      "Email sources require an imaps://host[:port] URL without credentials or a folder path.",
    );
  }
  return parsed;
}

function validateEmailSourceUrl(value: string): URL {
  const trimmed = value.trim();
  if (/^imaps:/i.test(trimmed)) return validateEmailImapUrl(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw sourceError("invalid", "Email sources require an HTTPS webmail or imaps:// URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some(isCredentialParameter)
  ) {
    throw sourceError(
      "invalid",
      "Webmail sources require HTTPS without embedded credentials or credential-like parameters.",
    );
  }
  return parsed;
}

function displayOriginFor(parsed: URL, kind: StudyBuddySourceKind): string {
  return kind === "email" && parsed.protocol === "imaps:"
    ? `imaps://${parsed.host}`
    : parsed.origin;
}

function entryPathFor(parsed: URL, kind: StudyBuddySourceKind): string {
  return kind === "calendar" || (kind === "email" && parsed.protocol === "imaps:")
    ? ""
    : `${parsed.pathname}${parsed.search}`;
}

function validatePrivateBearerUrl(value: string): URL {
  const normalized = value.trim().replace(/^webcal:\/\//i, "https://");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw sourceError("invalid", "Private calendar links require HTTPS.");
  }
  return parsed;
}

function publicLegacyUrl(value: string): URL {
  const normalized = value.replace(/^webcal:\/\//i, "https://");
  const parsed = new URL(normalized);
  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.forEach((_value, key) => {
    if (isCredentialParameter(key)) parsed.searchParams.delete(key);
  });
  if (parsed.hostname === "calendar.invalid") {
    parsed.pathname = "/";
    parsed.search = "";
  }
  return parsed;
}

function adapterForKind(kind: StudyBuddySourceKind): StudyBuddySourceAdapterDescriptor {
  const adapter = ADAPTERS.find((entry) => entry.kind === kind);
  if (!adapter) throw sourceError("invalid", "Unsupported source type.");
  return adapter;
}

function publicAuthForCreate(
  auth: StudyBuddyCreateSourceInput["auth"],
): StudyBuddySourceConnection["auth"] {
  if (auth.operation === "set-none") return { mode: "none", state: "not-required" };
  if (auth.operation === "set-bearer-url") return { mode: "bearer-url", state: "configured" };
  return {
    mode: "password",
    state: "configured",
    accountLabel: auth.username,
    ...(auth.emailAddress ? { emailAddress: auth.emailAddress } : {}),
  };
}

function storedAuth(auth: StudyBuddySourceConnection["auth"]): StudyBuddySourceConnection["auth"] {
  return { mode: auth.mode, state: auth.state };
}

function sanitizeStoredAuthMetadata(document: StoredSourceDocument): StoredSourceDocument {
  if (
    !document.connections.some(
      (connection) => connection.auth.accountLabel || connection.auth.emailAddress,
    )
  ) {
    return document;
  }
  return {
    ...document,
    connections: document.connections.map((connection) => ({
      ...connection,
      auth: storedAuth(connection.auth),
    })),
  };
}

function secretFromCreate(auth: StudyBuddyCreateSourceInput["auth"]): SourceSecret | null {
  if (auth.operation === "set-password") {
    return {
      type: "password",
      username: auth.username,
      password: auth.password,
      ...(auth.emailAddress ? { emailAddress: auth.emailAddress } : {}),
    };
  }
  return auth.operation === "set-bearer-url" ? { type: "bearer-url", value: auth.value } : null;
}

async function safeWebsiteProbe(value: string): Promise<void> {
  await assertPublicHttpsUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(value, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "text/html, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    await response.body?.cancel();
  } finally {
    clearTimeout(timeout);
  }
}

function assertRevision(document: StoredSourceDocument, expected: number): void {
  if (document.revision !== expected) {
    throw sourceError("conflict", "Sources changed on this device. Reload and try again.");
  }
}

function sourceError(code: StudyBuddySourceError["code"], message: string): StudyBuddySourceError {
  return new StudyBuddySourceError({ code, message });
}

function mapSourceError(error: unknown): never {
  if (isStudyBuddySourceError(error)) throw error;
  throw sourceError("internal", safeErrorMessage(error));
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Source operation failed.";
  return raw
    .replace(/(?:https?|webcal|imaps):\/\/\S+/gi, "[redacted URL]")
    .replace(/(password|token|key|secret|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function success(sourceId: string, message: string, code = "ok"): StudyBuddySourceTestResult {
  return { sourceId, status: "success", code, message, checkedAt: nowIso() };
}

function failure(sourceId: string, code: string, message: string): StudyBuddySourceTestResult {
  return { sourceId, status: "failure", code, message, checkedAt: nowIso() };
}

function legacyTargetFor(sourceId: string): "moodle" | "cis" | "calendar" | null {
  if (sourceId === "legacy-moodle") return "moodle";
  if (sourceId === "legacy-cis") return "cis";
  if (sourceId === "legacy-calendar") return "calendar";
  return null;
}

function legacySecretFor(
  connectionId: string,
  values: Readonly<Record<string, string>>,
): SourceSecret | null {
  if (connectionId === "legacy-moodle-connection") {
    return values.MOODLE_USERNAME && values.MOODLE_PASSWORD
      ? {
          type: "password",
          username: values.MOODLE_USERNAME,
          password: values.MOODLE_PASSWORD,
        }
      : null;
  }
  if (connectionId === "legacy-cis-connection") {
    const username = values.CIS_USERNAME || values.MOODLE_USERNAME;
    const password = values.CIS_PASSWORD || values.MOODLE_PASSWORD;
    return username && password ? { type: "password", username, password } : null;
  }
  if (connectionId === "legacy-calendar-connection" && values.CIS_CALENDAR_URL) {
    return { type: "bearer-url", value: values.CIS_CALENDAR_URL };
  }
  return null;
}

function defaultPriority(kind: StudyBuddySourceKind): number {
  return kind === "calendar" ? 10 : kind === "moodle-course" ? 20 : kind === "email" ? 40 : 30;
}

function pathPrefix(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return pathname.slice(0, Math.max(1, lastSlash + 1));
}

function isCredentialParameter(value: string): boolean {
  return /(?:token|secret|password|passwd|passcode|api[_-]?key|auth|credential)/i.test(value);
}

function firstUrl(value: string | undefined): string | null {
  return value?.split(/[\s,]+/).find(Boolean) ?? null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
