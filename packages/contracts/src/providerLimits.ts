/**
 * Live account limits contract.
 *
 * Distinct from `usage.ts`: that one scans provider transcripts to reconstruct
 * historical token spend, this one reports the subscription quota a provider
 * pushed at us mid-turn ("5-hour window 87% used, resets 10:50 PM"). The
 * providers only volunteer it while a turn is running, so a reading is always
 * last-known-value with an `observedAt` for the client to age.
 *
 * Antigravity reports no quota at all, so its snapshots carry `tokensUsed`
 * instead of `windows`. T3 is the only thing that can attribute those tokens
 * to an account, since agy shares one OS credential entry across profiles.
 *
 * @module providerLimits
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** A rolling quota window, normalized across providers. */
export const ProviderLimitWindow = Schema.Struct({
  /** Provider's own key for the window, e.g. `five_hour` or `primary`. */
  key: TrimmedNonEmptyString,
  /** Display label, e.g. `5-hour`, `Weekly`. */
  label: TrimmedNonEmptyString,
  /** Fraction of the window consumed, 0..1. */
  utilization: Schema.Number,
  /** Epoch seconds at which the window rolls over, when the provider says. */
  resetsAt: Schema.optional(Schema.Number),
});
export type ProviderLimitWindow = typeof ProviderLimitWindow.Type;

export const ProviderLimitStatus = Schema.Literals(["allowed", "allowed_warning", "rejected"]);
export type ProviderLimitStatus = typeof ProviderLimitStatus.Type;

export const ProviderLimitsSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  status: Schema.optional(ProviderLimitStatus),
  planType: Schema.optional(TrimmedNonEmptyString),
  windows: Schema.Array(ProviderLimitWindow),
  /** Only meaningful for providers that report no window. */
  tokensUsed: Schema.optional(NonNegativeInt),
  turns: Schema.optional(NonNegativeInt),
  observedAt: IsoDateTime,
});
export type ProviderLimitsSnapshot = typeof ProviderLimitsSnapshot.Type;

export const ProviderLimitsReport = Schema.Struct({
  snapshots: Schema.Array(ProviderLimitsSnapshot),
});
export type ProviderLimitsReport = typeof ProviderLimitsReport.Type;
