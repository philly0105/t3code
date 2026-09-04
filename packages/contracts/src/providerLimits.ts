/**
 * Live account limits contract.
 *
 * Distinct from `usage.ts`: that one scans provider transcripts to reconstruct
 * historical token spend, this one reports the subscription quota a provider
 * reports ("5-hour window 87% used, resets 10:50 PM").
 *
 * Readings arrive two ways. Claude and Codex push theirs mid-turn, which makes
 * a pushed reading last-known-value with an `observedAt` for the client to age.
 * Claude, Codex, Antigravity, and Grok can also be asked directly, which
 * costs no turn and no tokens; see `provider/providerUsage`.
 *
 * `tokensUsed` is the fallback for a provider that reports no window at all.
 * T3 is the only thing that can attribute agy's tokens to an account, since
 * agy shares one OS credential entry across profiles.
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
  /**
   * Reset time as the provider worded it, for providers that only print a
   * human string (`Sep 3, 1:30am`). Rendered when `resetsAt` is absent.
   */
  resetsLabel: Schema.optional(TrimmedNonEmptyString),
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

/**
 * Drivers whose CLI answers a quota question without running a turn.
 *
 * The server is authoritative — it checks whether the adapter implements the
 * read — but a client needs this to decide whether to offer `/usage` at all.
 */
const USAGE_READ_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "agy", "grok"]);

export const supportsUsageRead = (provider: ProviderDriverKind): boolean =>
  USAGE_READ_DRIVERS.has(provider);

/** Which instance to ask. The provider answers for the account it is signed in as. */
export const ProviderUsageReadInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ProviderUsageReadInput = typeof ProviderUsageReadInput.Type;

export class ProviderUsageReadError extends Schema.TaggedErrorClass<ProviderUsageReadError>()(
  "ProviderUsageReadError",
  {
    reason: Schema.Literals(["unsupported", "readFailed"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider usage read failed (${this.reason}): ${this.detail}`;
  }
}
