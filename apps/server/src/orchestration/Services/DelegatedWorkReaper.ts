import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface DelegatedWorkReaperShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class DelegatedWorkReaper extends Context.Service<
  DelegatedWorkReaper,
  DelegatedWorkReaperShape
>()("t3/orchestration/Services/DelegatedWorkReaper") {}
