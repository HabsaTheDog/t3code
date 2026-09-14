import { DesktopHealthEventSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import {
  readDesktopHealthEvents,
  acknowledgeDesktopHealthEvents,
} from "../../app/DesktopHealthJournal.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getHealthEvents = makeIpcMethod({
  channel: Channels.GET_HEALTH_EVENTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopHealthEventSchema),
  handler: Effect.fn("desktop.ipc.health.read")(function* () {
    const env = yield* DesktopEnvironment;
    return yield* Effect.promise(() => readDesktopHealthEvents(env).catch(() => []));
  }),
});
export const acknowledgeHealthEvents = makeIpcMethod({
  channel: Channels.ACK_HEALTH_EVENTS_CHANNEL,
  payload: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.health.acknowledge")(function* (ids) {
    const env = yield* DesktopEnvironment;
    yield* Effect.promise(() => acknowledgeDesktopHealthEvents(env, ids).catch(() => undefined));
  }),
});
