// @effect-diagnostics nodeBuiltinImport:off -- Isolated permission assertions for a local fixture.
import { readFile, stat, writeFile } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSourceSecretKeyStore from "./DesktopSourceSecretKeyStore.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type StorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "unknown";

function protectedBytes(value: string): Uint8Array {
  return Uint8Array.from(encoder.encode(value), (byte) => byte ^ 0xa5);
}

function safeStorageLayer(input: {
  readonly available?: boolean;
  readonly backend?: StorageBackend;
}) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(input.available ?? true),
    selectedStorageBackend: input.backend
      ? Effect.succeed(input.backend)
      : Effect.succeed("unknown"),
    encryptString: (value) => Effect.succeed(protectedBytes(value)),
    decryptString: (value) =>
      Effect.succeed(decoder.decode(Uint8Array.from(value, (byte) => byte ^ 0xa5))),
  } satisfies ElectronSafeStorage.ElectronSafeStorageShape);
}

function keyStoreLayer(
  baseDir: string,
  input: {
    readonly platform: NodeJS.Platform;
    readonly available?: boolean;
    readonly backend?: StorageBackend;
  },
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: input.platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return DesktopSourceSecretKeyStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer(input)),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withFixture = <A, E, R>(
  input: {
    readonly platform: NodeJS.Platform;
    readonly available?: boolean;
    readonly backend?: StorageBackend;
  },
  effect: (
    baseDir: string,
  ) => Effect.Effect<A, E, R | DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "study-buddy-source-key-test-",
    });
    return yield* effect(baseDir).pipe(Effect.provide(keyStoreLayer(baseDir, input)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopSourceSecretKeyStore", () => {
  it.effect("uses Fedora Secret Service, persists only protected bytes, and reuses the key", () =>
    withFixture({ platform: "linux", backend: "gnome_libsecret" }, (baseDir) =>
      Effect.gen(function* () {
        const store = yield* DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore;
        const first = yield* store.getOrCreate;
        const second = yield* store.getOrCreate;
        assert.equal(first, second);
        assert.equal(Buffer.from(first, "base64").length, 32);

        const keyPath = `${baseDir}/userdata/source-secret-key.json`;
        const raw = yield* Effect.promise(() => readFile(keyPath, "utf8"));
        assert.notInclude(raw, first);
        assert.equal((yield* Effect.promise(() => stat(keyPath))).mode & 0o777, 0o600);
        assert.equal(
          (yield* Effect.promise(() => stat(`${baseDir}/userdata`))).mode & 0o777,
          0o700,
        );
      }),
    ),
  );

  it.effect("accepts Windows DPAPI even though Electron reports no Linux backend name", () =>
    withFixture({ platform: "win32", backend: "unknown" }, () =>
      Effect.gen(function* () {
        const store = yield* DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore;
        assert.equal(Buffer.from(yield* store.getOrCreate, "base64").length, 32);
      }),
    ),
  );

  it.effect("fails closed for Electron's insecure Linux basic_text fallback", () =>
    withFixture({ platform: "linux", backend: "basic_text" }, () =>
      Effect.gen(function* () {
        const store = yield* DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore;
        const error = yield* Effect.flip(store.getOrCreate);
        assert.include(error.message, "secure Linux Secret Service backend is required");
      }),
    ),
  );

  it.effect("does not replace a malformed or undecryptable persisted key", () =>
    withFixture({ platform: "linux", backend: "gnome_libsecret" }, (baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const keyPath = `${baseDir}/userdata/source-secret-key.json`;
        yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* Effect.promise(() => writeFile(keyPath, '{"version":1,"encryptedKey":"%%%"}\n'));
        const store = yield* DesktopSourceSecretKeyStore.DesktopSourceSecretKeyStore;
        yield* Effect.flip(store.getOrCreate);
        assert.equal(
          yield* Effect.promise(() => readFile(keyPath, "utf8")),
          '{"version":1,"encryptedKey":"%%%"}\n',
        );
      }),
    ),
  );
});
