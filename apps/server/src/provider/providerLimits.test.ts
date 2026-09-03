import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  accumulateTokenUsage,
  foldProviderLimitEvent,
  parseProviderLimits,
} from "./providerLimits.ts";

// Captured verbatim from a real `account.rate-limits.updated` event so the
// parser is pinned to the shape the SDK actually sends, not a guess at it.
const CLAUDE_PAYLOAD = {
  rateLimits: {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1788414600,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: 1788414600 },
        seven_day: { utilization: 0.12, resetsAt: 1788764400 },
      },
    },
    uuid: "5ff88cbf-ccad-42d3-acd9-ebba77947d06",
    session_id: "0737b4e1-5965-4a16-9010-57849fa36d1e",
  },
};

// Codex nests one level deeper than Claude and reports whole percentages.
const CODEX_PAYLOAD = {
  rateLimits: {
    rateLimits: {
      credits: { balance: "1880.3742800000", hasCredits: true, unlimited: false },
      individualLimit: null,
      limitId: "codex",
      limitName: null,
      planType: "plus",
      primary: { resetsAt: 1788405496, usedPercent: 56, windowDurationMins: 300 },
      rateLimitReachedType: null,
      secondary: { resetsAt: 1788756169, usedPercent: 10, windowDurationMins: 10080 },
      spendControlReached: null,
    },
  },
};

describe("parseProviderLimits", () => {
  it("reads Claude's named windows and rejection status", () => {
    const parsed = parseProviderLimits(CLAUDE_PAYLOAD);
    expect(parsed?.status).toBe("rejected");
    expect(parsed?.windows).toEqual([
      { key: "five_hour", label: "5-hour", utilization: 1, resetsAt: 1788414600 },
      { key: "seven_day", label: "Weekly", utilization: 0.12, resetsAt: 1788764400 },
    ]);
  });

  it("reads Codex's nested windows and converts percent to a fraction", () => {
    const parsed = parseProviderLimits(CODEX_PAYLOAD);
    expect(parsed?.planType).toBe("plus");
    expect(parsed?.windows).toEqual([
      { key: "primary", label: "5-hour", utilization: 0.56, resetsAt: 1788405496 },
      { key: "secondary", label: "Weekly", utilization: 0.1, resetsAt: 1788756169 },
    ]);
  });

  it("labels an unrecognized Codex window from its duration", () => {
    const parsed = parseProviderLimits({
      rateLimits: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 4320 } } },
    });
    expect(parsed?.windows[0]?.label).toBe("3-day");
  });

  it("keeps a Claude window type it has no label for", () => {
    const parsed = parseProviderLimits({
      rateLimits: {
        rate_limit_info: { unifiedWindows: { thirty_day: { utilization: 0.5 } } },
      },
    });
    expect(parsed?.windows).toEqual([{ key: "thirty_day", label: "Thirty day", utilization: 0.5 }]);
  });

  it("returns undefined when no window can be read, so a stale reading survives", () => {
    expect(parseProviderLimits(undefined)).toBeUndefined();
    expect(parseProviderLimits({})).toBeUndefined();
    expect(
      parseProviderLimits({ rateLimits: { rateLimits: { planType: "plus" } } }),
    ).toBeUndefined();
  });
});

describe("accumulateTokenUsage", () => {
  const input = {
    providerInstanceId: ProviderInstanceId.make("agy_a1"),
    provider: ProviderDriverKind.make("agy"),
    usedTokens: 1200,
    observedAt: "2026-09-03T04:00:00.000Z",
  };

  it("starts a total for an instance not seen before", () => {
    const snapshot = accumulateTokenUsage(undefined, input);
    expect(snapshot.tokensUsed).toBe(1200);
    expect(snapshot.turns).toBe(1);
    expect(snapshot.windows).toEqual([]);
  });

  it("adds to the running total across turns", () => {
    const first = accumulateTokenUsage(undefined, input);
    const second = accumulateTokenUsage(first, { ...input, usedTokens: 800 });
    expect(second.tokensUsed).toBe(2000);
    expect(second.turns).toBe(2);
  });
});

describe("accumulateTokenUsage window preservation", () => {
  it("keeps quota windows a provider already reported", () => {
    const withWindows = {
      providerInstanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      windows: [{ key: "primary", label: "5-hour", utilization: 0.5 }],
      observedAt: "2026-09-03T03:00:00.000Z",
    };
    const next = accumulateTokenUsage(withWindows, {
      providerInstanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      usedTokens: 500,
      observedAt: "2026-09-03T04:00:00.000Z",
    });
    expect(next.windows).toEqual(withWindows.windows);
    expect(next.tokensUsed).toBe(500);
  });
});

describe("foldProviderLimitEvent", () => {
  const base = {
    eventId: EventId.make("11111111-1111-4111-8111-111111111111"),
    provider: ProviderDriverKind.make("claudeAgent"),
    threadId: ThreadId.make("22222222-2222-4222-8222-222222222222"),
    createdAt: "2026-09-03T04:00:00.000Z",
  } as const;

  it("records a rate-limit reading against the reporting instance", () => {
    const next = foldProviderLimitEvent(undefined, {
      ...base,
      providerInstanceId: ProviderInstanceId.make("claudeAgent_alt"),
      type: "account.rate-limits.updated",
      payload: CLAUDE_PAYLOAD,
    } as ProviderRuntimeEvent);
    expect(next?.providerInstanceId).toBe("claudeAgent_alt");
    expect(next?.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly"]);
  });

  it("keys off the driver when an event predates instance ids", () => {
    const next = foldProviderLimitEvent(undefined, {
      ...base,
      type: "account.rate-limits.updated",
      payload: CLAUDE_PAYLOAD,
    } as ProviderRuntimeEvent);
    expect(next?.providerInstanceId).toBe("claudeAgent");
  });

  it("accumulates turn tokens for a provider that reports no quota", () => {
    const event = {
      ...base,
      provider: ProviderDriverKind.make("agy"),
      providerInstanceId: ProviderInstanceId.make("agy_a1"),
      type: "turn.completed",
      payload: { state: "completed", usage: { usedTokens: 900 } },
    } as ProviderRuntimeEvent;
    const first = foldProviderLimitEvent(undefined, event);
    const second = foldProviderLimitEvent(first, event);
    expect(second?.tokensUsed).toBe(1800);
    expect(second?.turns).toBe(2);
  });

  it("ignores events that carry no limit or usage", () => {
    expect(
      foldProviderLimitEvent(undefined, {
        ...base,
        type: "turn.started",
        payload: {},
      } as ProviderRuntimeEvent),
    ).toBeUndefined();
    expect(
      foldProviderLimitEvent(undefined, {
        ...base,
        type: "turn.completed",
        payload: { state: "completed" },
      } as ProviderRuntimeEvent),
    ).toBeUndefined();
  });
});
