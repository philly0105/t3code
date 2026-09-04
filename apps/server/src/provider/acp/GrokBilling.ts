/**
 * Grok `/usage` without a turn.
 *
 * The TUI talks to `x.ai/billing` over ACP. `grok agent stdio` on current
 * stable CLIs (1.0.13 included) answers that method with JSON-RPC -32601, so
 * the same credits config is fetched from the CLI chat proxy that the
 * extension handler itself calls.
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = "grok";
const READ_USAGE = "readUsage";
const DEFAULT_GROK_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_TOKEN_AUTH_VALUE = "xai-grok-cli";
const BILLING_FETCH_TIMEOUT_MS = 15_000;

export type GrokCachedAuth = {
  readonly key: string;
  readonly userId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function grokCliProxyBaseUrl(environment?: NodeJS.ProcessEnv): string {
  const override = environment?.GROK_CLI_CHAT_PROXY_BASE_URL?.trim();
  const base = override && override.length > 0 ? override : DEFAULT_GROK_CLI_PROXY_BASE_URL;
  return base.replace(/\/+$/, "");
}

export function grokHomeDirectory(environment?: NodeJS.ProcessEnv): string | undefined {
  const explicit = environment?.GROK_HOME?.trim();
  if (explicit) return explicit;
  const home = environment?.HOME?.trim() || environment?.USERPROFILE?.trim();
  return home ? NodePath.join(home, ".grok") : undefined;
}

export function parseGrokCachedAuth(raw: unknown): GrokCachedAuth | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  for (const value of Object.values(root)) {
    const entry = asRecord(value);
    const key = asString(entry?.["key"]);
    if (!key) continue;
    const userId = asString(entry?.["user_id"]);
    return userId === undefined ? { key } : { key, userId };
  }
  return undefined;
}

function visitUnsupported(value: unknown, depth: number): boolean {
  if (value == null || depth > 8) return false;
  if (typeof value === "number") return value === -32601;
  if (typeof value === "string") {
    return value.includes("Method not found") || value.includes("-32601");
  }
  if (Array.isArray(value)) {
    return value.some((entry) => visitUnsupported(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["code"] === -32601) return true;
  const message = asString(record["errorMessage"]) ?? asString(record["message"]);
  if (message && (message.includes("Method not found") || message.includes("-32601"))) {
    return true;
  }
  return (
    visitUnsupported(record["cause"], depth + 1) || visitUnsupported(record["defect"], depth + 1)
  );
}

/** True when Grok's stdio ACP has no `x.ai/billing` handler. */
export function isGrokAcpBillingUnsupported(error: unknown): boolean {
  return visitUnsupported(error, 0);
}

function usageReadError(detail: string, cause?: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: READ_USAGE,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const readGrokCliProxyBilling = (input: {
  readonly fileSystem: FileSystem.FileSystem["Service"];
  readonly path: Path.Path["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}): Effect.Effect<unknown, ProviderAdapterRequestError> =>
  Effect.gen(function* () {
    const grokHome = grokHomeDirectory(input.environment);
    if (!grokHome) {
      return yield* usageReadError("Grok home was not found; sign in with `grok login`.");
    }
    const authPath = input.path.join(grokHome, "auth.json");
    const raw = yield* input.fileSystem
      .readFileString(authPath)
      .pipe(
        Effect.mapError((cause) =>
          usageReadError("Could not read the Grok login cache. Sign in with `grok login`.", cause),
        ),
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return yield* usageReadError("Grok login cache was not valid JSON.", cause);
    }
    const auth = parseGrokCachedAuth(parsed);
    if (!auth) {
      return yield* usageReadError(
        "Grok login cache has no session token. Sign in with `grok login`.",
      );
    }

    const url = `${grokCliProxyBaseUrl(input.environment)}/billing?format=credits`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${auth.key}`,
      "X-XAI-Token-Auth": GROK_CLI_TOKEN_AUTH_VALUE,
    };
    if (auth.userId) headers["x-userid"] = auth.userId;

    const fetchImpl = input.fetch ?? globalThis.fetch;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(BILLING_FETCH_TIMEOUT_MS),
        }),
      catch: (cause) => usageReadError("Failed to reach the Grok billing service.", cause),
    });
    if (!response.ok) {
      return yield* usageReadError(`Grok billing service error: HTTP ${response.status}.`);
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => usageReadError("Grok billing service returned invalid JSON.", cause),
    });
  });
