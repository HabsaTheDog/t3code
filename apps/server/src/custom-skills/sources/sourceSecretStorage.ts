// @effect-diagnostics nodeBuiltinImport:off -- AES-GCM is the server-side at-rest boundary.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { StudyBuddySourceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ServerSecretStoreShape } from "../../auth/ServerSecretStore.ts";
import type { ServerConfigShape } from "../../config.ts";

export interface PasswordSourceSecret {
  readonly type: "password";
  readonly username: string;
  readonly password: string;
  readonly emailAddress?: string;
}

export interface BearerSourceSecret {
  readonly type: "bearer-url";
  readonly value: string;
}

export type SourceSecret = PasswordSourceSecret | BearerSourceSecret;

const SourceSecretSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("password"),
    username: Schema.String.check(Schema.isMaxLength(1_000)),
    password: Schema.String.check(Schema.isMaxLength(20_000)),
    emailAddress: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
  }),
  Schema.Struct({
    type: Schema.Literal("bearer-url"),
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  }),
]);
const decodeSourceSecret = Schema.decodeUnknownSync(SourceSecretSchema);

const EncryptedSourceSecretSchema = Schema.Struct({
  version: Schema.Literal(2),
  algorithm: Schema.Literal("aes-256-gcm"),
  iv: Schema.String,
  ciphertext: Schema.String,
  authTag: Schema.String,
});
type EncryptedSourceSecret = typeof EncryptedSourceSecretSchema.Type;
const decodeEncryptedSourceSecret = Schema.decodeUnknownSync(EncryptedSourceSecretSchema);
const isStudyBuddySourceError = Schema.is(StudyBuddySourceError);

const sourceError = (code: "internal" | "unavailable", message: string) =>
  new StudyBuddySourceError({ code, message });

function legacyStorageName(connectionId: string): string {
  return `study-source-auth-${createHash("sha256").update(connectionId).digest("hex")}`;
}

function encryptedStorageName(connectionId: string): string {
  return `${legacyStorageName(connectionId)}-v2`;
}

function sourceSecretKey(config: ServerConfigShape): Buffer {
  if (!config.sourceSecretKey) {
    throw sourceError(
      "unavailable",
      "Secure source storage is unavailable. Start Study Buddy with its desktop application.",
    );
  }
  const key = Buffer.from(config.sourceSecretKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== config.sourceSecretKey) {
    throw sourceError("internal", "Secure source storage received an invalid key.");
  }
  return key;
}

function encrypt(
  config: ServerConfigShape,
  name: string,
  value: SourceSecret,
): EncryptedSourceSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sourceSecretKey(config), iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: 2,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(
  config: ServerConfigShape,
  name: string,
  envelope: EncryptedSourceSecret,
): SourceSecret {
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (iv.length !== 12 || authTag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", sourceSecretKey(config), iv);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return decodeSourceSecret(JSON.parse(plaintext));
  } catch (error) {
    if (isStudyBuddySourceError(error)) throw error;
    throw sourceError(
      "unavailable",
      "Stored source credentials could not be unlocked. Re-enter them after checking secure storage.",
    );
  }
}

function isEncrypted(value: unknown): value is EncryptedSourceSecret {
  try {
    decodeEncryptedSourceSecret(value);
    return true;
  } catch {
    return false;
  }
}

export async function setSourceSecret(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
  connectionId: string,
  value: SourceSecret,
): Promise<void> {
  const name = encryptedStorageName(connectionId);
  const legacyName = legacyStorageName(connectionId);
  const envelope = encrypt(config, name, value);
  await Effect.runPromise(secrets.set(name, new TextEncoder().encode(JSON.stringify(envelope))));
  const persisted = await Effect.runPromise(secrets.get(name));
  if (!persisted) throw sourceError("internal", "Encrypted source credential was not persisted.");
  const persistedEnvelope = decodeEncryptedSourceSecret(
    JSON.parse(new TextDecoder().decode(persisted)),
  );
  if (JSON.stringify(decrypt(config, name, persistedEnvelope)) !== JSON.stringify(value)) {
    throw sourceError("internal", "Persisted source credential verification failed.");
  }
  await Effect.runPromise(secrets.remove(legacyName));
}

export async function getSourceSecret(
  config: ServerConfigShape,
  secrets: ServerSecretStoreShape,
  connectionId: string,
): Promise<SourceSecret | null> {
  const name = encryptedStorageName(connectionId);
  const legacyName = legacyStorageName(connectionId);
  const encryptedBytes = await Effect.runPromise(secrets.get(name));
  if (encryptedBytes) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(encryptedBytes));
      if (!isEncrypted(parsed)) throw new Error("invalid encrypted source secret");
      const value = decrypt(config, name, parsed);
      await Effect.runPromise(secrets.remove(legacyName));
      return value;
    } catch (error) {
      if (isStudyBuddySourceError(error)) throw error;
      throw sourceError(
        "unavailable",
        "Stored source credentials could not be unlocked. Re-enter them after checking secure storage.",
      );
    }
  }

  const bytes = await Effect.runPromise(secrets.get(legacyName));
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const legacy = isEncrypted(parsed)
      ? decrypt(config, legacyName, parsed)
      : decodeSourceSecret(parsed);
    const envelope = encrypt(config, name, legacy);
    if (JSON.stringify(decrypt(config, name, envelope)) !== JSON.stringify(legacy)) {
      throw sourceError("internal", "Source credential migration verification failed.");
    }
    await Effect.runPromise(secrets.set(name, new TextEncoder().encode(JSON.stringify(envelope))));
    const persisted = await Effect.runPromise(secrets.get(name));
    if (!persisted) throw sourceError("internal", "Encrypted source credential was not persisted.");
    const persistedEnvelope = decodeEncryptedSourceSecret(
      JSON.parse(new TextDecoder().decode(persisted)),
    );
    if (JSON.stringify(decrypt(config, name, persistedEnvelope)) !== JSON.stringify(legacy)) {
      throw sourceError("internal", "Persisted source credential verification failed.");
    }
    await Effect.runPromise(secrets.remove(legacyName));
    return legacy;
  } catch (error) {
    if (isStudyBuddySourceError(error)) throw error;
    throw sourceError(
      "unavailable",
      "Stored source credentials could not be unlocked. Re-enter them after checking secure storage.",
    );
  }
}

export async function removeSourceSecret(
  secrets: ServerSecretStoreShape,
  connectionId: string,
): Promise<void> {
  await Effect.runPromise(
    Effect.all([
      secrets.remove(encryptedStorageName(connectionId)),
      secrets.remove(legacyStorageName(connectionId)),
    ]).pipe(Effect.asVoid),
  );
}
