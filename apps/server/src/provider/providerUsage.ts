/**
 * Normalizes the providers' on-demand usage reports into `ProviderLimitWindow`.
 *
 * Distinct from `providerLimits.ts`, which folds the quota providers volunteer
 * mid-turn. Every reading here is pulled on request, and all three sources cost
 * no turn and no tokens:
 *
 * - Claude: `claude -p /usage --output-format json`, whose `result` is the same
 *   human text the TUI prints, so it is parsed line by line.
 * - Codex: the app-server `account/rateLimits/read` response, which is already
 *   the shape `parseProviderLimits` reads.
 * - Antigravity: `agy -p /usage --output-format json`, which answers with
 *   structured groups of buckets under `command.data`.
 *
 * Pure and Effect-free; the spawning lives in the adapters.
 *
 * @module provider/providerUsage
 */
import type { ProviderLimitWindow, ProviderLimitsSnapshot } from "@t3tools/contracts";

import { parseProviderLimits } from "./providerLimits.ts";

/** What an adapter reports; the service stamps identity and `observedAt`. */
export type ProviderUsageReading = Pick<ProviderLimitsSnapshot, "status" | "planType" | "windows">;

/** CLI stdout is only ever JSON by convention, so a bad line is data, not a crash. */
export function parseJsonOrUndefined(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `Current week (all models)` to `current_week_all_models`. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Claude prints its limits as prose, one window per line:
 * `Current session: 79% used · resets Sep 3, 1:30am (America/Los_Angeles)`.
 *
 * Only the reset text is available, not an epoch, so it lands in `resetsLabel`.
 * The trailing timezone is dropped because the times are already local.
 */
export function parseClaudeUsageText(text: string): ReadonlyArray<ProviderLimitWindow> {
  const windows: Array<ProviderLimitWindow> = [];
  for (const line of text.split("\n")) {
    const match = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const label = match[1]?.trim();
    const percent = match[2] === undefined ? undefined : Number.parseFloat(match[2]);
    if (!label || percent === undefined || !Number.isFinite(percent)) continue;
    const resetsLabel = match[3]?.replace(/\s*\([^)]*\)\s*$/, "").trim();
    windows.push({
      key: slugify(label),
      label,
      utilization: percent / 100,
      ...(resetsLabel ? { resetsLabel } : {}),
    });
  }
  return windows;
}

/** The `claude -p` envelope, which carries the printed text under `result`. */
export function parseClaudeUsageReport(raw: unknown): ProviderUsageReading | undefined {
  const text = asString(asRecord(raw)?.["result"]);
  if (text === undefined) return undefined;
  const windows = parseClaudeUsageText(text);
  return windows.length === 0 ? undefined : { windows };
}

/** Codex answers `account/rateLimits/read` in the shape it also pushes. */
export function parseCodexUsageReport(raw: unknown): ProviderUsageReading | undefined {
  return parseProviderLimits(raw);
}

/**
 * `Gemini Models` to `Gemini`. The group names read as sentences because agy
 * prints them above a paragraph; in a bar label the trailing noun is noise.
 */
function shortenGroupName(name: string): string {
  return name.replace(/\s+models$/i, "").trim() || name;
}

/** `weekly` to `Weekly`, `5h` to `5-hour`. Falls back to the bucket's own name. */
function labelForAgyWindow(window: string | undefined, bucketName: string): string {
  if (window === undefined) return bucketName;
  if (window === "weekly") return "Weekly";
  const hours = /^(\d+)h$/.exec(window);
  if (hours) return `${hours[1]}-hour`;
  const days = /^(\d+)d$/.exec(window);
  if (days) return `${days[1]}-day`;
  return bucketName;
}

/**
 * agy's `/usage` answer: groups of models that share a quota, each with a
 * weekly and a rolling bucket. Buckets report what is *left*, so utilization is
 * the complement.
 */
export function parseAgyUsageReport(raw: unknown): ProviderUsageReading | undefined {
  const data = asRecord(asRecord(asRecord(raw)?.["command"])?.["data"]);
  const groups = asArray(data?.["groups"]);
  if (!groups) return undefined;

  const windows: Array<ProviderLimitWindow> = [];
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    const groupName = asString(group?.["name"]);
    for (const rawBucket of asArray(group?.["buckets"]) ?? []) {
      const bucket = asRecord(rawBucket);
      const remaining = asNumber(bucket?.["remaining_fraction"]);
      if (!bucket || remaining === undefined) continue;
      const bucketName = asString(bucket["name"]) ?? "Limit";
      const windowLabel = labelForAgyWindow(asString(bucket["window"]), bucketName);
      const resetTime = asString(bucket["reset_time"]);
      const resetsAt = resetTime === undefined ? Number.NaN : Date.parse(resetTime) / 1000;
      windows.push({
        key: asString(bucket["id"]) ?? slugify(`${groupName ?? ""} ${bucketName}`),
        label: groupName ? `${shortenGroupName(groupName)} · ${windowLabel}` : windowLabel,
        utilization: 1 - remaining,
        ...(Number.isFinite(resetsAt) ? { resetsAt: Math.floor(resetsAt) } : {}),
      });
    }
  }
  return windows.length === 0 ? undefined : { windows };
}
