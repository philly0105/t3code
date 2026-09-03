/**
 * ProviderLimitsService - live account limits and usage per provider instance.
 *
 * Holds the most recent limit reading each provider instance has pushed, so a
 * client can ask "how much of my 5-hour window is left" without waiting for a
 * turn. State is deliberately in-memory: limits are live facts with reset
 * times, not history worth persisting, and a reading that survived a restart
 * would only be stale.
 *
 * @module provider/Services/ProviderLimits
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { ProviderLimitsSnapshot } from "@t3tools/contracts";

export interface ProviderLimitsShape {
  /** Subscribe to the runtime event stream. Call once at server activation. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Latest reading per provider instance, most recently observed first. */
  readonly list: Effect.Effect<ReadonlyArray<ProviderLimitsSnapshot>>;
  /**
   * File a reading pulled on demand, so a `/usage` run also freshens the
   * limits panel instead of only answering the caller.
   */
  readonly record: (snapshot: ProviderLimitsSnapshot) => Effect.Effect<void>;
}

export class ProviderLimitsService extends Context.Service<
  ProviderLimitsService,
  ProviderLimitsShape
>()("t3/provider/Services/ProviderLimits/ProviderLimitsService") {}

/** Empty store for tests that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  ProviderLimitsService,
  ProviderLimitsService.of({
    start: () => Effect.void,
    list: Effect.succeed([]),
    record: () => Effect.void,
  }),
);
