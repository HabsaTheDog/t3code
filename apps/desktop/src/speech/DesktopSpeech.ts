// @effect-diagnostics nodeBuiltinImport:off - This service is the isolated native download/process boundary for Electron.
// @effect-diagnostics globalFetch:off - The model archive is streamed with Range support from a single fixed HTTPS URL.
// @effect-diagnostics globalDate:off - Wall-clock throttling only limits progress-file writes.
// @effect-diagnostics globalErrorInEffectCatch:off
// @effect-diagnostics globalErrorInEffectFailure:off
// @effect-diagnostics preferSchemaOverJson:off - State and sidecar JSON are private, versioned implementation details.
import type { DesktopSpeechModelState, DesktopSpeechTranscriptionResult } from "@t3tools/contracts";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { spawn } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const MODEL_ID = "parakeet-tdt-0.6b-v3-int8" as const;
const MODEL_URL = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const MODEL_SHA256 = "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77";
const MAX_RECORDING_WAV_BYTES = 7 * 1024 * 1024;

type SpeechPaths = {
  root: string;
  state: string;
  archive: string;
  extracting: string;
  model: string;
};

export interface DesktopSpeechShape {
  readonly getState: Effect.Effect<DesktopSpeechModelState>;
  readonly enable: Effect.Effect<DesktopSpeechModelState>;
  readonly remove: Effect.Effect<DesktopSpeechModelState>;
  readonly transcribe: (
    wavBase64: string,
  ) => Effect.Effect<DesktopSpeechTranscriptionResult, Error>;
}

export class DesktopSpeech extends Context.Service<DesktopSpeech, DesktopSpeechShape>()(
  "@t3tools/desktop/speech/DesktopSpeech",
) {}

function disabledState(): DesktopSpeechModelState {
  return {
    status: "not-enabled",
    model: MODEL_ID,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(command: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function findModelDirectory(root: string): Promise<string | null> {
  const required = ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"];
  const containsModel = async (candidate: string) =>
    (await Promise.all(required.map((name) => pathExists(Path.join(candidate, name))))).every(
      Boolean,
    );
  if (await containsModel(root)) return root;
  for (const entry of await Fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = Path.join(root, entry.name);
      if (await containsModel(candidate)) return candidate;
    }
  }
  return null;
}

function sidecarExecutable(environment: DesktopEnvironment.DesktopEnvironmentShape): string {
  const executable = process.platform === "win32" ? "study-buddy-speech.exe" : "study-buddy-speech";
  const override = process.env.T3CODE_SPEECH_SIDECAR_PATH?.trim();
  if (override) return override;
  if (environment.isPackaged)
    return Path.join(environment.resourcesPath, "speech-sidecar", executable);
  return Path.join(
    environment.appRoot,
    "apps/desktop/native/speech-sidecar/target/release",
    executable,
  );
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const paths: SpeechPaths = {
    root: Path.join(environment.stateDir, "speech"),
    state: Path.join(environment.stateDir, "speech", "state.json"),
    archive: Path.join(environment.stateDir, "speech", `${MODEL_ID}.tar.gz.part`),
    extracting: Path.join(environment.stateDir, "speech", `${MODEL_ID}.extracting`),
    model: Path.join(environment.stateDir, "speech", MODEL_ID),
  };
  let current = disabledState();
  let loaded = false;
  let downloadTask: Promise<void> | null = null;

  const persist = async () => {
    await Fs.mkdir(paths.root, { recursive: true });
    await Fs.writeFile(paths.state, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  };

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await Fs.readFile(paths.state, "utf8")) as DesktopSpeechModelState;
      if (parsed.model === MODEL_ID) current = parsed;
    } catch {
      current = disabledState();
    }
    if (current.status === "ready" && !(await pathExists(paths.model))) {
      current = { ...current, status: "error", error: "The speech model files are missing." };
      await persist();
    }
  };

  const setState = async (patch: Partial<DesktopSpeechModelState>) => {
    current = { ...current, ...patch, model: MODEL_ID };
    await persist();
  };

  const extractArchive = async () => {
    await setState({ status: "verifying", error: null });
    const digest = await sha256(paths.archive);
    if (digest !== MODEL_SHA256) {
      await Fs.rm(paths.archive, { force: true });
      throw new Error("The downloaded Parakeet archive failed its integrity check.");
    }
    await Fs.rm(paths.extracting, { recursive: true, force: true });
    await Fs.mkdir(paths.extracting, { recursive: true });
    await runProcess("tar", ["-xzf", paths.archive, "-C", paths.extracting]);
    const extractedModel = await findModelDirectory(paths.extracting);
    if (!extractedModel)
      throw new Error("The Parakeet archive does not contain the expected model files.");
    await Fs.rm(paths.model, { recursive: true, force: true });
    if (extractedModel === paths.extracting) {
      await Fs.rename(paths.extracting, paths.model);
    } else {
      await Fs.rename(extractedModel, paths.model);
      await Fs.rm(paths.extracting, { recursive: true, force: true });
    }
    await Fs.rm(paths.archive, { force: true });
    await setState({ status: "ready", error: null });
  };

  const download = async () => {
    try {
      await Fs.mkdir(paths.root, { recursive: true });
      const downloadedBytes = (await Fs.stat(paths.archive).catch(() => null))?.size ?? 0;
      await setState({ status: "downloading", downloadedBytes, error: null });
      const response = await fetch(MODEL_URL, {
        headers: downloadedBytes > 0 ? { Range: `bytes=${downloadedBytes}-` } : {},
      });
      if (!response.ok || !response.body)
        throw new Error(`Model download failed (${response.status}).`);
      const isResume = response.status === 206 && downloadedBytes > 0;
      const initialBytes = isResume ? downloadedBytes : 0;
      if (!isResume && downloadedBytes > 0) await Fs.rm(paths.archive, { force: true });
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
      const totalBytes = Number.isFinite(contentLength) ? initialBytes + contentLength : null;
      let written = initialBytes;
      const output = createWriteStream(paths.archive, { flags: isResume ? "a" : "w" });
      const reader = response.body.getReader();
      let lastPersist = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (!output.write(value))
            await new Promise<void>((resolve) => output.once("drain", resolve));
          written += value.byteLength;
          current = { ...current, downloadedBytes: written, totalBytes };
          if (Date.now() - lastPersist > 750) {
            lastPersist = Date.now();
            await persist();
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject);
          output.end(resolve);
        });
      }
      await persist();
      await extractArchive();
    } catch (error) {
      await setState({
        status: "error",
        error: error instanceof Error ? error.message : "Speech model installation failed.",
      });
    } finally {
      downloadTask = null;
    }
  };

  const ensureDownload = async () => {
    await load();
    if (current.status === "ready" || current.status === "not-enabled") return;
    downloadTask ??=
      current.status === "verifying" && (await pathExists(paths.archive))
        ? extractArchive()
            .catch(async (error: unknown) => {
              await setState({
                status: "error",
                error: error instanceof Error ? error.message : "Speech model installation failed.",
              });
            })
            .finally(() => {
              downloadTask = null;
            })
        : download();
  };

  void load().then(() => {
    if (current.status === "downloading" || current.status === "verifying") {
      void ensureDownload();
    }
  });

  return DesktopSpeech.of({
    getState: Effect.promise(async () => {
      await load();
      if (current.status === "downloading" || current.status === "verifying") void ensureDownload();
      return current;
    }),
    enable: Effect.promise(async () => {
      await load();
      if (current.status !== "ready") {
        current = { ...current, status: "downloading", error: null };
        await persist();
        void ensureDownload();
      }
      return current;
    }),
    remove: Effect.promise(async () => {
      await load();
      current = disabledState();
      await persist();
      if (!downloadTask) {
        await Fs.rm(paths.archive, { force: true });
        await Fs.rm(paths.extracting, { recursive: true, force: true });
      }
      await Fs.rm(paths.model, { recursive: true, force: true });
      return current;
    }),
    transcribe: (wavBase64) =>
      Effect.tryPromise({
        try: async () => {
          await load();
          if (current.status !== "ready") throw new Error("Parakeet V3 is not ready yet.");
          const temporaryDirectory = await Fs.mkdtemp(Path.join(paths.root, "recording-"));
          const audioPath = Path.join(temporaryDirectory, "voice.wav");
          try {
            const wav = Buffer.from(wavBase64, "base64");
            if (wav.byteLength === 0 || wav.byteLength > MAX_RECORDING_WAV_BYTES) {
              throw new Error("The voice recording is empty or longer than the 3 minute limit.");
            }
            await Fs.writeFile(audioPath, wav);
            const output = await runProcess(sidecarExecutable(environment), [
              "--model",
              paths.model,
              "--audio",
              audioPath,
            ]);
            const parsed = JSON.parse(output) as { text?: unknown };
            if (typeof parsed.text !== "string" || !parsed.text.trim()) {
              throw new Error("No speech was detected in the recording.");
            }
            return { text: parsed.text.trim() };
          } finally {
            await Fs.rm(temporaryDirectory, { recursive: true, force: true });
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
  });
});

export const layer = Layer.effect(DesktopSpeech, make);
