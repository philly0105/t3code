/**
 * Live wiring for {@link ProviderLimitsService}.
 *
 * Subscribes to `ProviderService.streamEvents` in its own fiber rather than
 * hooking into orchestration ingestion. `streamEvents` hands out a fresh
 * PubSub subscription per access, so a second consumer is free, and keeping
 * this off the ingestion path means a slow reader here can never delay a turn.
 *
 * The fold itself is pure and lives in `../providerLimits.ts`.
 *
 * @module provider/Layers/ProviderLimits
 */
import type { ProviderInstanceId, ProviderLimitsSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { foldProviderLimitEvent } from "../providerLimits.ts";
import { ProviderLimitsService, type ProviderLimitsShape } from "../Services/ProviderLimits.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const snapshots = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderLimitsSnapshot>>(
    new Map(),
  );

  const start: ProviderLimitsShape["start"] = () =>
    forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        Ref.update(snapshots, (current) => {
          const key = (event.providerInstanceId ?? event.provider) as ProviderInstanceId;
          const next = foldProviderLimitEvent(current.get(key), event);
          if (next === undefined) return current;
          const updated = new Map(current);
          updated.set(next.providerInstanceId, next);
          return updated;
        }),
      ),
    );

  const list = Ref.get(snapshots).pipe(
    Effect.map((current) =>
      Array.from(current.values()).sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    ),
  );

  return { start, list } satisfies ProviderLimitsShape;
});

export const ProviderLimitsLive = Layer.effect(ProviderLimitsService, make);
