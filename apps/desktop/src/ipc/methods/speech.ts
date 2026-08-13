import {
  DesktopSpeechModelStateSchema,
  DesktopSpeechTranscriptionResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSpeech from "../../speech/DesktopSpeech.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getSpeechModelState = makeIpcMethod({
  channel: IpcChannels.SPEECH_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechModelStateSchema,
  handler: Effect.fn("desktop.ipc.speech.getState")(function* () {
    return yield* (yield* DesktopSpeech.DesktopSpeech).getState;
  }),
});

export const enableSpeechModel = makeIpcMethod({
  channel: IpcChannels.SPEECH_ENABLE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechModelStateSchema,
  handler: Effect.fn("desktop.ipc.speech.enable")(function* () {
    return yield* (yield* DesktopSpeech.DesktopSpeech).enable;
  }),
});

export const removeSpeechModel = makeIpcMethod({
  channel: IpcChannels.SPEECH_REMOVE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechModelStateSchema,
  handler: Effect.fn("desktop.ipc.speech.remove")(function* () {
    return yield* (yield* DesktopSpeech.DesktopSpeech).remove;
  }),
});

export const transcribeSpeech = makeIpcMethod({
  channel: IpcChannels.SPEECH_TRANSCRIBE_CHANNEL,
  payload: Schema.String,
  result: DesktopSpeechTranscriptionResultSchema,
  handler: Effect.fn("desktop.ipc.speech.transcribe")(function* (wavBase64) {
    return yield* (yield* DesktopSpeech.DesktopSpeech).transcribe(wavBase64);
  }),
});
