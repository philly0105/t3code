import { describe, expect, it } from "@effect/vitest";

import {
  parseAgyUsageReport,
  parseClaudeUsageReport,
  parseClaudeUsageText,
  parseCodexUsageReport,
  parseGrokUsageReport,
} from "./providerUsage.ts";

// Captured verbatim from `claude -p "/usage" --output-format json` so the
// parser is pinned to the text the CLI actually prints. The trailing prose is
// kept because it is the part most likely to produce a false match.
const CLAUDE_USAGE_TEXT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 79% used · resets Sep 3, 1:30am (America/Los_Angeles)",
  "Current week (all models): 9% used · resets Sep 4, 7am (America/Los_Angeles)",
  "",
  "What's contributing to your limits usage?",
  "",
  "Last 24h · 593 requests · 10 sessions",
  "  45% of your usage was at >150k context",
  "  Top skills: /superpowers:systematic-debugging 4%, /agy-delegation 3%",
].join("\n");

// Captured verbatim from the app-server `account/rateLimits/read` response.
const CODEX_RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1788424125 },
    secondary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: 1788756169 },
    credits: { hasCredits: true, unlimited: false, balance: "1880.3742800000" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

// Captured verbatim from `agy -p "/usage" --output-format json`.
const AGY_USAGE = {
  conversation_id: "",
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9580885767936707,
              reset_time: "2026-09-09T05:48:31Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.8364120721817017,
              reset_time: "2026-09-03T06:54:28Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-09-10T05:58:20Z",
            },
          ],
        },
      ],
    },
  },
};

describe("parseClaudeUsageText", () => {
  it("reads one window per printed limit line", () => {
    expect(parseClaudeUsageText(CLAUDE_USAGE_TEXT)).toEqual([
      {
        key: "current_session",
        label: "Current session",
        utilization: 0.79,
        resetsLabel: "Sep 3, 1:30am",
      },
      {
        key: "current_week_all_models",
        label: "Current week (all models)",
        utilization: 0.09,
        resetsLabel: "Sep 4, 7am",
      },
    ]);
  });

  it("ignores percentages in the contributing-usage prose", () => {
    const windows = parseClaudeUsageText(
      ["  45% of your usage was at >150k context", "  Top skills: /a 4%, /b 3%"].join("\n"),
    );
    expect(windows).toEqual([]);
  });

  it("keeps a window whose reset time the CLI omitted", () => {
    expect(parseClaudeUsageText("Current session: 12% used")).toEqual([
      { key: "current_session", label: "Current session", utilization: 0.12 },
    ]);
  });
});

describe("parseClaudeUsageReport", () => {
  it("reads the text out of the print-mode envelope", () => {
    const reading = parseClaudeUsageReport({ subtype: "success", result: CLAUDE_USAGE_TEXT });
    expect(reading?.windows.map((window) => window.key)).toEqual([
      "current_session",
      "current_week_all_models",
    ]);
  });

  it("returns undefined when the envelope carries no limits", () => {
    expect(parseClaudeUsageReport({ result: "Login required." })).toBeUndefined();
    expect(parseClaudeUsageReport({ is_error: true })).toBeUndefined();
  });
});

describe("parseCodexUsageReport", () => {
  it("reads the read-response the same way as the pushed event", () => {
    expect(parseCodexUsageReport(CODEX_RATE_LIMITS)).toEqual({
      planType: "plus",
      windows: [
        { key: "primary", label: "5-hour", utilization: 0.23, resetsAt: 1788424125 },
        { key: "secondary", label: "Weekly", utilization: 0.14, resetsAt: 1788756169 },
      ],
    });
  });
});

// Captured from Grok's ACP `x.ai/billing` credits-config shape (and the
// `billing: fetched credits config` unified-log payload, which is the same
// object). creditUsagePercent is 0–100, not a 0–1 fraction.
const GROK_CREDITS = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-08T00:00:00Z",
    },
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 300 },
    prepaidBalance: { val: 1250 },
    isUnifiedBillingUser: true,
  },
  onDemandEnabled: true,
  subscriptionTier: "SuperGrok",
};

const GROK_LEGACY_BILLING = {
  config: {
    monthlyLimit: { val: 2000 },
    used: { val: 500 },
    billingPeriodEnd: "2025-05-01T00:00:00Z",
  },
};

describe("parseGrokUsageReport", () => {
  it("reads the credits-config percent, period, and on-demand window", () => {
    expect(parseGrokUsageReport(GROK_CREDITS)).toEqual({
      planType: "SuperGrok",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          utilization: 0.425,
          resetsAt: Math.floor(Date.parse("2026-06-08T00:00:00Z") / 1000),
        },
        {
          key: "on_demand",
          label: "On-demand",
          utilization: 300 / 5000,
        },
      ],
    });
  });

  it("falls back to the older monthlyLimit/used cents shape", () => {
    expect(parseGrokUsageReport(GROK_LEGACY_BILLING)).toEqual({
      windows: [
        {
          key: "monthly",
          label: "Monthly",
          utilization: 0.25,
          resetsAt: Math.floor(Date.parse("2025-05-01T00:00:00Z") / 1000),
        },
      ],
    });
  });

  it("returns undefined when the answer carries no limits", () => {
    expect(parseGrokUsageReport({ config: null })).toBeUndefined();
    expect(parseGrokUsageReport({ config: {} })).toBeUndefined();
    expect(parseGrokUsageReport({ status: "ok" })).toBeUndefined();
  });

  it("skips a zero on-demand cap", () => {
    const reading = parseGrokUsageReport({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
    });
    expect(reading?.windows.map((window) => window.key)).toEqual(["weekly"]);
  });
});

describe("parseAgyUsageReport", () => {
  it("flattens groups of buckets and inverts the remaining fraction", () => {
    const reading = parseAgyUsageReport(AGY_USAGE);
    expect(reading?.windows).toEqual([
      {
        key: "gemini-weekly",
        label: "Gemini · Weekly",
        utilization: 1 - 0.9580885767936707,
        resetsAt: 1788932911,
      },
      {
        key: "gemini-5h",
        label: "Gemini · 5-hour",
        utilization: 1 - 0.8364120721817017,
        resetsAt: 1788418468,
      },
      {
        key: "3p-weekly",
        label: "Claude and GPT · Weekly",
        utilization: 0,
        resetsAt: 1789019900,
      },
    ]);
  });

  it("returns undefined when the answer carries no groups", () => {
    expect(parseAgyUsageReport({ status: "SUCCESS", response: "hi" })).toBeUndefined();
    expect(
      parseAgyUsageReport({ command: { name: "usage", data: { groups: [] } } }),
    ).toBeUndefined();
  });
});
