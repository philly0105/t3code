import { type GrokSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");
/** ACP extension the Grok TUI `/usage` screen uses. Not a model turn. */
export const GROK_ACP_BILLING_METHOD = "x.ai/billing";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function grokAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "default", "agent", "stdio"];
    case "auto-accept-edits":
      return ["--permission-mode", "acceptEdits", "agent", "stdio"];
    case "auto":
      return ["--permission-mode", "auto", "agent", "stdio"];
    case "full-access":
      return ["agent", "--always-approve", "stdio"];
    default:
      return ["agent", "stdio"];
  }
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: [...grokAcpSpawnArgs(runtimeMode)],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

/**
 * Ask Grok for the signed-in account's quota without opening a session.
 *
 * `session/new` boots MCP servers; `authenticate` can open a browser login.
 * This path initializes, authenticates headless, then calls `x.ai/billing`,
 * which is the same RPC the TUI `/usage` screen uses. The process is scoped
 * to the call so a `/usage` read cannot leak an ACP child.
 */
export const readGrokAcpBilling = (input: {
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
}): Effect.Effect<unknown, EffectAcpErrors.AcpError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const acp = yield* makeGrokAcpRuntime({
      grokSettings: input.grokSettings,
      ...(input.environment ? { environment: input.environment } : {}),
      childProcessSpawner: input.childProcessSpawner,
      cwd: input.cwd,
      clientInfo: { name: "t3-code-usage-read", version: "0.0.0" },
    });
    yield* acp.initialize();
    yield* acp.request("authenticate", {
      methodId: resolveGrokAuthMethodId(input.environment),
      _meta: { headless: true },
    });
    return yield* acp.request(GROK_ACP_BILLING_METHOD, {});
  }).pipe(Effect.scoped);

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

/**
 * T3's built-in Grok slug. It is the CLI's product name, not a model id the ACP accepts,
 * so selecting it means "use whatever model the Grok session currently runs on".
 */
export const GROK_DEFAULT_MODEL_SLUG = "grok-build";

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : GROK_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? GROK_DEFAULT_MODEL_SLUG;
}

const GROK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidGrokReasoningEffortToken(value: string): boolean {
  return GROK_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeGrokReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidGrokReasoningEffortToken(effort) ? effort : undefined;
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentGrokReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizeGrokReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // The product slug is never sent over the wire; it keeps the session's current model.
  const requestedModelId =
    input.requestedModelId === GROK_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  const modelChanged = requestedModelId !== undefined && requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeGrokReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  const targetModelId = requestedModelId ?? input.currentModelId;
  if ((!modelChanged && !reasoningEffortChanged) || targetModelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  const reasoningMeta =
    reasoningProvided && reasoningEffort !== undefined ? { reasoningEffort } : undefined;
  // When reasoning was explicitly provided but invalid (normalize => undefined), we deliberately
  // send no meta so the invalid value is dropped rather than forwarded. When reasoning was not
  // provided at all, we also send no meta, but we only reach this call when the model itself
  // changed - an omitted reasoning preference must not be treated as an explicit clear of the
  // CLI-advertised default (e.g. Extra High) on same-model reselections.
  return input.runtime
    .setSessionModel(targetModelId, reasoningMeta)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}
