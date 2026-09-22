import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { ProviderInstanceSetupError, type ProviderManageInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import { makeProviderAuthService } from "./Layers/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

/** Installation belongs to the Study Buddy environment; OAuth belongs to its initiating client. */
export const makeProviderManagement = Effect.gen(function* () {
  const installation = yield* AntigravityInstallation;
  const registry = yield* ProviderInstanceRegistry;
  const authService = yield* makeProviderAuthService;
  return (input: ProviderManageInput, ownerSessionId: string) =>
    Effect.gen(function* () {
      const failure = (detail: string) =>
        new ProviderInstanceSetupError({
          instanceId: input.instanceId,
          operation: input.action,
          detail,
        });
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance || instance.driverKind !== "antigravity")
        return yield* failure("Select an available Gemini provider instance.");
      switch (input.action) {
        case "install":
          yield* installation.start.pipe(Effect.mapError((cause) => failure(cause.detail)));
          break;
        case "install-cancel":
          if (!input.operationId) return yield* failure("The installation identifier is required.");
          yield* installation
            .cancel(input.operationId)
            .pipe(Effect.mapError((cause) => failure(cause.detail)));
          break;
        case "auth-start":
          yield* authService.start(input, ownerSessionId);
          break;
        case "auth-complete":
          if (!input.flowId || !input.callbackUrl)
            return yield* failure("The sign-in flow and callback are required.");
          yield* authService.complete(
            { ...input, flowId: input.flowId, callbackUrl: input.callbackUrl },
            ownerSessionId,
          );
          break;
        case "auth-cancel":
          if (!input.flowId) return yield* failure("The sign-in flow identifier is required.");
          yield* authService.cancel({ ...input, flowId: input.flowId }, ownerSessionId);
          break;
        case "logout":
          yield* authService.logout(input);
          break;
        case "refresh-models":
          yield* (
            instance
              .refreshModels?.()
              .pipe(
                Effect.mapError(() =>
                  failure("Could not refresh Gemini models. Check sign-in and retry."),
                ),
              ) ?? Effect.void
          );
          break;
        case "status":
          break;
      }
      const auth = yield* authService.subscribe(input, ownerSessionId).pipe(Stream.runHead);
      if (Option.isNone(auth)) return yield* failure("Provider sign-in status is unavailable.");
      return { install: yield* installation.state, auth: auth.value };
    });
});

export class ProviderManagement extends Context.Service<
  ProviderManagement,
  Effect.Success<typeof makeProviderManagement>
>()("t3/provider/providerManagement") {
  static layer = Layer.effect(ProviderManagement, makeProviderManagement);
}
