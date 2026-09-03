/**
 * Formatting shared by the Limits page and the `/usage` composer banner, so a
 * window reads the same wherever it lands.
 *
 * @module components/limits/limitsPresentation
 */
import type { ProviderLimitWindow } from "@t3tools/contracts";

/** `1788414600` to `10:50 PM` or `Sep 7, 3:00 PM` when it is not today. */
export function formatReset(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("en-US", {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * The trailing `· resets …` clause, empty when the provider said nothing.
 * Prefers the epoch so the time renders in the reader's locale, and falls back
 * to the provider's own wording for those that only print a string.
 */
export function formatWindowReset(window: ProviderLimitWindow): string {
  if (window.resetsAt !== undefined) {
    const formatted = formatReset(window.resetsAt);
    return formatted === "" ? "" : ` · resets ${formatted}`;
  }
  return window.resetsLabel === undefined ? "" : ` · resets ${window.resetsLabel}`;
}

/** `2026-09-02T21:14:03Z` to `3m ago`. */
export function formatAge(observedAt: string): string {
  const ms = Date.now() - Date.parse(observedAt);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function barColor(utilization: number): string {
  if (utilization >= 1) return "bg-destructive";
  if (utilization >= 0.8) return "bg-amber-500";
  return "bg-primary";
}
