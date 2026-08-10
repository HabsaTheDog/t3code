import { DownloadIcon, MicIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useDesktopSpeechActions, useDesktopSpeechState } from "../../lib/desktopSpeechReactQuery";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export interface ComposerVoiceNote {
  id: string;
  durationMs: number;
  transcript: string;
}

export type PendingComposerVoiceNote = Pick<ComposerVoiceNote, "id" | "durationMs">;

function buildRecordingWavePath(amplitude: number, phase: number): string {
  const points: string[] = [];
  const pointCount = 24;
  for (let index = 0; index <= pointCount; index += 1) {
    const progress = index / pointCount;
    const x = 2 + progress * 16;
    const edgeEnvelope = 0.55 + Math.sin(progress * Math.PI) * 0.45;
    const y = 10 + Math.sin(progress * Math.PI * 4 + phase) * amplitude * edgeEnvelope;
    points.push(`${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join(" ");
}

function RecordingWaveform({ analyser }: { analyser: AnalyserNode | null }) {
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const path = pathRef.current;
    if (!path || !analyser) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      path.setAttribute("d", buildRecordingWavePath(0.75, 0));
      return;
    }

    const samples = new Uint8Array(analyser.fftSize);
    let animationFrame = 0;
    const animationStartedAt = performance.now();
    let lastSampleAt = animationStartedAt;
    let smoothedLevel = 0;

    const draw = (time: number) => {
      const elapsedMs = time - lastSampleAt;
      if (elapsedMs >= 33) {
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        const normalizedLevel = Math.max(0, Math.min(1, (rms - 0.018) / 0.055));
        const targetLevel = normalizedLevel ** 0.65;
        const transitionMs = targetLevel > smoothedLevel ? 170 : 280;
        const smoothing = 1 - Math.exp(-elapsedMs / transitionMs);
        smoothedLevel += (targetLevel - smoothedLevel) * smoothing;
        path.setAttribute(
          "d",
          buildRecordingWavePath(0.28 + smoothedLevel * 5.35, (time - animationStartedAt) / 115),
        );
        lastSampleAt = time;
      }
      animationFrame = window.requestAnimationFrame(draw);
    };

    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [analyser]);

  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 overflow-visible">
      <path
        ref={pathRef}
        d={buildRecordingWavePath(0.28, 0)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function recordingToWav(blob: Blob): Promise<ArrayBuffer> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const targetRate = 16_000;
    const frames = Math.ceil(decoded.duration * targetRate);
    const offline = new OfflineAudioContext(1, frames, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), targetRate);
  } finally {
    await context.close();
  }
}

export function formatVoiceDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComposerVoiceInput({
  disabled,
  onVoiceNote,
  onTranscriptionChange,
}: {
  disabled: boolean;
  onVoiceNote: (note: ComposerVoiceNote) => void;
  onTranscriptionChange: (note: PendingComposerVoiceNote | null) => void;
}) {
  const speech = useDesktopSpeechState();
  const speechActions = useDesktopSpeechActions();
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingAnalyserRef = useRef<AnalyserNode | null>(null);
  const startedAtRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);
  const state = speech.data;

  const stopRecordingAnalysis = useCallback(() => {
    recordingAudioSourceRef.current?.disconnect();
    recordingAudioSourceRef.current = null;
    recordingAnalyserRef.current = null;
    const context = recordingAudioContextRef.current;
    recordingAudioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }, []);

  useEffect(
    () => () => {
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      stopRecordingAnalysis();
    },
    [stopRecordingAnalysis],
  );

  if (!state || state.status === "not-enabled") return null;

  const stop = () => {
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
  };
  const start = async () => {
    if (disabled || state.status !== "ready") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      try {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        recordingAudioContextRef.current = context;
        recordingAudioSourceRef.current = source;
        recordingAnalyserRef.current = analyser;
        void context.resume().catch(() => undefined);
      } catch {
        stopRecordingAnalysis();
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - startedAtRef.current;
        stopRecordingAnalysis();
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
        if (durationMs < 350) {
          setPhase("idle");
          return;
        }
        const id = randomUUID();
        setPhase("transcribing");
        onTranscriptionChange({ id, durationMs });
        void recordingToWav(new Blob(chunks, { type: recorder.mimeType }))
          .then((wav) => window.desktopBridge!.transcribeSpeech(toBase64(wav)))
          .then(({ text }) => onVoiceNote({ id, durationMs, transcript: text }))
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Voice transcription failed",
              description:
                error instanceof Error ? error.message : "Could not transcribe this recording.",
            });
          })
          .finally(() => {
            onTranscriptionChange(null);
            setPhase("idle");
          });
      };
      recorder.start();
      setPhase("recording");
      stopTimerRef.current = window.setTimeout(stop, 3 * 60 * 1000);
    } catch (error) {
      stopRecordingAnalysis();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: error instanceof Error ? error.message : "Microphone access was denied.",
      });
    }
  };

  const percentage =
    state.totalBytes && state.totalBytes > 0
      ? Math.max(0, Math.min(100, (state.downloadedBytes / state.totalBytes) * 100))
      : null;
  const percentageLabel =
    percentage === null
      ? null
      : percentage > 0 && percentage < 0.1
        ? "<0.1%"
        : `${percentage.toFixed(1).replace(/\.0$/, "")}%`;
  const isInstalling = state.status === "downloading" || state.status === "verifying";
  const ringPercentage = state.status === "verifying" ? 100 : (percentage ?? 0);
  const ringRadius = 14.5;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference - (ringPercentage / 100) * ringCircumference;
  const title =
    state.status === "downloading"
      ? `Downloading Parakeet V3 voice transcription model${percentageLabel === null ? "" : ` · ${percentageLabel}`}`
      : state.status === "verifying"
        ? "Parakeet V3 is being verified and installed"
        : state.status === "error"
          ? `Parakeet V3 installation failed${state.error ? `: ${state.error}` : ""}`
          : phase === "recording"
            ? "Stop voice recording"
            : phase === "transcribing"
              ? "Transcribing voice input locally"
              : "Record voice input with Parakeet V3";

  const button = (
    <Button
      type="button"
      data-analytics-id="chat.voice-input"
      variant="default"
      size="icon"
      className="relative rounded-full"
      disabled={
        disabled ||
        phase === "transcribing" ||
        state.status === "downloading" ||
        state.status === "verifying"
      }
      aria-label={title}
      aria-pressed={phase === "recording"}
      onClick={
        phase === "recording"
          ? stop
          : state.status === "error"
            ? () => void speechActions.enable()
            : () => void start()
      }
    >
      {state.status === "verifying" ? (
        <Spinner className="size-4" />
      ) : phase === "recording" ? (
        <RecordingWaveform analyser={recordingAnalyserRef.current} />
      ) : state.status === "downloading" || state.status === "error" ? (
        <DownloadIcon className="size-4" />
      ) : (
        <MicIcon className="size-4" />
      )}
    </Button>
  );

  const trigger = isInstalling ? (
    <span
      className="relative inline-flex size-9 shrink-0 cursor-progress items-center justify-center rounded-full sm:size-8"
      aria-label={title}
      tabIndex={0}
    >
      {button}
      <svg
        aria-hidden="true"
        viewBox="0 0 32 32"
        className="pointer-events-none absolute inset-0 size-full -rotate-90 transform-gpu overflow-visible"
      >
        <circle
          cx="16"
          cy="16"
          r={ringRadius}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
          strokeWidth="2"
        />
        <circle
          cx="16"
          cy="16"
          r={ringRadius}
          fill="none"
          stroke="var(--color-muted-foreground)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={ringCircumference}
          strokeDashoffset={ringOffset}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
    </span>
  ) : (
    button
  );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top">
        {state.status === "downloading" ? (
          <span className="flex flex-col gap-0.5 py-0.5">
            <span>Downloading voice transcription model</span>
            <span className="text-muted-foreground tabular-nums">
              Parakeet V3 · {percentageLabel ?? "Starting download…"}
            </span>
          </span>
        ) : (
          title
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
