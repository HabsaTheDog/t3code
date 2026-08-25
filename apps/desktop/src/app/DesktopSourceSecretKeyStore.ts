import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const SOURCE_SECRET_KEY_BYTES = 32;

const SourceSecretKeyDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedKey: Schema.String,
});
const SourceSecretKeyDocumentJson = fromLenientJson(SourceSecretKeyDocument);
const decodeDocument = Schema.decodeEffect(SourceSecretKeyDocumentJson);
const encodeDocument = Schema.encodeEffect(SourceSecretKeyDocumentJson);

export class DesktopSourceSecretKeyStoreError extends Data.TaggedError(
  "DesktopSourceSecretKeyStoreError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DesktopSourceSecretKeyStoreShape {
  readonly getOrCreate: Effect.Effect<string, DesktopSourceSecretKeyStoreError>;
}

export class DesktopSourceSecretKeyStore extends Context.Service<
  DesktopSourceSecretKeyStore,
  DesktopSourceSecretKeyStoreShape
>()("@t3tools/desktop/app/DesktopSourceSecretKeyStore") {}

const secureLinuxBackends = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

function requireSecureBackend(input: {
  readonly platform: NodeJS.Platform;
  readonly available: boolean;
  readonly backend: string;
}): Effect.Effect<void, DesktopSourceSecretKeyStoreError> {
  if (!input.available) {
    return Effect.fail(
      new DesktopSourceSecretKeyStoreError({
        message: "Operating-system secret storage is unavailable.",
      }),
    );
  }
  if (input.platform === "linux" && !secureLinuxBackends.has(input.backend)) {
    return Effect.fail(
      new DesktopSourceSecretKeyStoreError({
        message:
          "A secure Linux Secret Service backend is required; Electron selected an insecure fallback.",
      }),
    );
  }
  return Effect.void;
}

function decodeEncryptedBytes(
  value: string,
): Effect.Effect<Uint8Array, DesktopSourceSecretKeyStoreError> {
  return Effect.fromResult(Encoding.decodeBase64(value)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSourceSecretKeyStoreError({
          message: "The encrypted source-secret key is malformed.",
          cause,
        }),
    ),
  );
}

function validateKey(value: string): Effect.Effect<string, DesktopSourceSecretKeyStoreError> {
  return Effect.fromResult(Encoding.decodeBase64(value)).pipe(
    Effect.filterOrFail(
      (bytes) => bytes.length === SOURCE_SECRET_KEY_BYTES,
      () =>
        new DesktopSourceSecretKeyStoreError({
          message: "The source-secret key has an invalid length.",
        }),
    ),
    Effect.as(value),
    Effect.mapError((cause) =>
      cause instanceof DesktopSourceSecretKeyStoreError
        ? cause
        : new DesktopSourceSecretKeyStoreError({
            message: "The source-secret key is malformed.",
            cause,
          }),
    ),
  );
}

export const layer = Layer.effect(
  DesktopSourceSecretKeyStore,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const crypto = yield* Crypto.Crypto;
    const keyPath = path.join(environment.stateDir, "source-secret-key.json");

    const checkBackend = safeStorage.isEncryptionAvailable.pipe(
      Effect.flatMap((available) =>
        environment.platform === "linux"
          ? safeStorage.selectedStorageBackend.pipe(
              Effect.flatMap((backend) =>
                requireSecureBackend({ platform: environment.platform, available, backend }),
              ),
            )
          : requireSecureBackend({ platform: environment.platform, available, backend: "unknown" }),
      ),
      Effect.mapError((cause) =>
        cause instanceof DesktopSourceSecretKeyStoreError
          ? cause
          : new DesktopSourceSecretKeyStoreError({
              message: "Failed to verify operating-system secret storage.",
              cause,
            }),
      ),
    );

    const readExisting = Effect.gen(function* () {
      const exists = yield* fileSystem.exists(keyPath);
      if (!exists) return Option.none<string>();
      const raw = yield* fileSystem.readFileString(keyPath);
      const document = yield* decodeDocument(raw);
      const encrypted = yield* decodeEncryptedBytes(document.encryptedKey);
      const decrypted = yield* safeStorage.decryptString(encrypted);
      return Option.some(yield* validateKey(decrypted));
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DesktopSourceSecretKeyStoreError
          ? cause
          : new DesktopSourceSecretKeyStoreError({
              message:
                "Failed to unlock the source-secret key. Study Buddy will not replace or expose it.",
              cause,
            }),
      ),
    );

    const create = Effect.gen(function* () {
      const key = Encoding.encodeBase64(yield* crypto.randomBytes(SOURCE_SECRET_KEY_BYTES));
      const encryptedKey = Encoding.encodeBase64(yield* safeStorage.encryptString(key));
      const encoded = yield* encodeDocument({ version: 1, encryptedKey });
      const suffix = (yield* crypto.randomUUIDv4).replace(/-/g, "");
      const tempPath = `${keyPath}.${process.pid}.${suffix}.tmp`;
      yield* fileSystem.makeDirectory(path.dirname(keyPath), { recursive: true });
      yield* fileSystem.chmod(path.dirname(keyPath), 0o700);
      yield* fileSystem.writeFileString(tempPath, `${encoded}\n`);
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* fileSystem.rename(tempPath, keyPath);
      yield* fileSystem.chmod(keyPath, 0o600);
      return key;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSourceSecretKeyStoreError({
            message: "Failed to create the operating-system-protected source-secret key.",
            cause,
          }),
      ),
    );

    return DesktopSourceSecretKeyStore.of({
      getOrCreate: checkBackend.pipe(
        Effect.andThen(readExisting),
        Effect.flatMap(Option.match({ onNone: () => create, onSome: Effect.succeed })),
        Effect.withSpan("desktop.sourceSecretKeyStore.getOrCreate"),
      ),
    });
  }),
);
