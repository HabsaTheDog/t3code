import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { readDesktopHealthEvents } from "../../app/DesktopHealthJournal.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getClientSettings = makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    yield* clientSettings.set(settings);
    if (settings.analyticsConsent !== "accepted") {
      const env = yield* Effect.serviceOption(DesktopEnvironment);
      if (Option.isSome(env))
        yield* Effect.promise(() => readDesktopHealthEvents(env.value).catch(() => []));
    }
  }),
});
