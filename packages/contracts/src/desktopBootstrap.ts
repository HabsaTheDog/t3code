import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  t3Home: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  sourceSecretKey: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/)),
  ),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
