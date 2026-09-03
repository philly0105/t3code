/**
 * Normalizes the providers' account limit reports into one shape.
 *
 * Claude and Codex both push their subscription limits as
 * `account.rate-limits.updated`, but in different shapes: Claude nests named
 * windows under `unifiedWindows` with fractional utilization, Codex reports
 * `primary`/`secondary` windows with a duration in minutes and integer
 * percentages. Both collapse to the same `ProviderLimitWindow` list here so
 * one panel can render either.
 *
 * Antigravity reports no quota at all — the CLI exposes no usage subcommand
 * and its stream-json output carries only per-turn token counts. For agy the
 * store accumulates tokens per instance instead, which T3 can attribute
 * because it owns the credential switching (see AgyCredentialProfile).
 *
 * Pure and Effect-free: the live wiring lives in Layers/ProviderLimitsService.
 *
 * @module provider/providerLimits
 */
import {
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderLimitStatus,
  type ProviderLimitWindow,
  type ProviderLimitsSnapshot,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStatus(value: unknown): ProviderLimitStatus | undefined {
  return value === "allowed" || value === "allowed_warning" || value === "rejected"
    ? value
    : undefined;
}

/**
 * Window labels. Claude names its windows; Codex only gives a duration, so
 * `labelForMinutes` covers it. Anything unrecognized falls back to the raw key
 * rather than being dropped, so a new provider window still shows up.
 */
const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  overage: "Overage",
};

function labelForMinutes(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Claude's shape: named windows with fractional utilization. */
function parseClaudeWindows(info: Record<string, unknown>): ReadonlyArray<ProviderLimitWindow> {
  const unified = asRecord(info["unifiedWindows"]);
  if (unified) {
    return Object.entries(unified).flatMap(([key, value]) => {
      const window = asRecord(value);
      const utilization = asNumber(window?.["utilization"]);
      if (!window || utilization === undefined) return [];
      const resetsAt = asNumber(window["resetsAt"]);
      return [
        {
          key,
          label: CLAUDE_WINDOW_LABELS[key] ?? humanizeKey(key),
          utilization,
          ...(resetsAt === undefined ? {} : { resetsAt }),
        },
      ];
    });
  }

  // Older SDKs reported a single flat window instead of `unifiedWindows`.
  const key = asString(info["rateLimitType"]);
  const utilization = asNumber(info["utilization"]);
  if (!key || utilization === undefined) return [];
  const resetsAt = asNumber(info["resetsAt"]);
  return [
    {
      key,
      label: CLAUDE_WINDOW_LABELS[key] ?? humanizeKey(key),
      utilization,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  ];
}

/** Codex's shape: primary/secondary with integer percent and a duration. */
function parseCodexWindows(info: Record<string, unknown>): ReadonlyArray<ProviderLimitWindow> {
  return (["primary", "secondary"] as const).flatMap((key) => {
    const window = asRecord(info[key]);
    const usedPercent = asNumber(window?.["usedPercent"]);
    if (!window || usedPercent === undefined) return [];
    const minutes = asNumber(window["windowDurationMins"]);
    const resetsAt = asNumber(window["resetsAt"]);
    return [
      {
        key,
        label: labelForMinutes(minutes) ?? humanizeKey(key),
        // Codex reports 0..100; the snapshot is always a fraction.
        utilization: usedPercent / 100,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ];
  });
}

/**
 * Reads an `account.rate-limits.updated` payload from either provider.
 *
 * Returns undefined when the payload carries no window we can render, so the
 * caller can leave the previous reading in place rather than blanking it.
 */
export function parseProviderLimits(
  rawPayload: unknown,
): Pick<ProviderLimitsSnapshot, "status" | "planType" | "windows"> | undefined {
  const payload = asRecord(rawPayload);
  const rateLimits = asRecord(payload?.["rateLimits"]) ?? payload;
  if (!rateLimits) return undefined;

  // Claude wraps the useful part one level down; Codex puts it at the top.
  const claudeInfo = asRecord(rateLimits["rate_limit_info"]);
  const info = claudeInfo ?? asRecord(rateLimits["rateLimits"]) ?? rateLimits;

  const windows = claudeInfo ? parseClaudeWindows(info) : parseCodexWindows(info);
  if (windows.length === 0) return undefined;

  const status = asStatus(info["status"]);
  const planType = asString(info["planType"]);
  return {
    ...(status === undefined ? {} : { status }),
    ...(planType === undefined ? {} : { planType }),
    windows,
  };
}

/**
 * Folds a turn's token count into an instance's running total.
 *
 * Recorded for every provider but only meaningful for those that report no
 * quota, so the UI shows it only when `windows` is empty. Any quota windows
 * already seen are preserved: a provider that reports both must not lose its
 * limits to a usage reading.
 */
export function accumulateTokenUsage(
  previous: ProviderLimitsSnapshot | undefined,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
    readonly usedTokens: number;
    readonly observedAt: string;
  },
): ProviderLimitsSnapshot {
  return {
    ...previous,
    providerInstanceId: input.providerInstanceId,
    provider: input.provider,
    windows: previous?.windows ?? [],
    tokensUsed: (previous?.tokensUsed ?? 0) + Math.max(0, input.usedTokens),
    turns: (previous?.turns ?? 0) + 1,
    observedAt: input.observedAt,
  };
}

/**
 * Folds one runtime event into an instance's snapshot.
 *
 * Returns undefined when the event carries nothing to record, so the caller
 * leaves the previous reading in place. Providers only publish their quota
 * mid-turn, which makes every reading a last-known value.
 */
export function foldProviderLimitEvent(
  previous: ProviderLimitsSnapshot | undefined,
  event: ProviderRuntimeEvent,
): ProviderLimitsSnapshot | undefined {
  // `providerInstanceId` is still optional during the driver/instance
  // migration; the driver slug is also the default instance's id, so the
  // fallback keys the same row rather than dropping the reading.
  const providerInstanceId = ProviderInstanceId.make(event.providerInstanceId ?? event.provider);

  if (event.type === "account.rate-limits.updated") {
    const parsed = parseProviderLimits(event.payload);
    if (!parsed) return undefined;
    return {
      ...previous,
      ...parsed,
      providerInstanceId,
      provider: event.provider,
      observedAt: event.createdAt,
    };
  }

  if (event.type === "turn.completed") {
    const usage = event.payload.usage as { usedTokens?: number } | undefined;
    const usedTokens = usage?.usedTokens;
    if (typeof usedTokens !== "number" || usedTokens <= 0) return undefined;
    return accumulateTokenUsage(previous, {
      providerInstanceId,
      provider: event.provider,
      usedTokens,
      observedAt: event.createdAt,
    });
  }

  return undefined;
}
