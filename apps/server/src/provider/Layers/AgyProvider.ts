import {
  type AgySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const AGY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AGY_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export function parseAgyModelsOutput(stdout: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Fetching"))
    .flatMap((line): ReadonlyArray<ServerProviderModel> => {
      const [rawSlug, rawName] = line.split("\t");
      const slug = rawSlug?.trim();
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: rawName?.trim() || slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        },
      ];
    });
}

export function buildInitialAgyProviderSnapshot(
  settings: AgySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings([], settings.customModels ?? [], EMPTY_CAPABILITIES);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: AGY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

const runAgyVersionCommand = (
  settings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const runAgyModelsCommand = (settings: AgySettings, environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["models"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkAgyProviderStatus = Effect.fn("checkAgyProviderStatus")(function* (
  settings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    [],
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Antigravity is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runAgyVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Antigravity CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Antigravity CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute Antigravity CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but timed out while running `agy --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version =
    versionOutput.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null;

  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Antigravity CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but failed to run.",
      },
    });
  }

  const modelsResult = yield* runAgyModelsCommand(settings, environment).pipe(
    Effect.timeoutOption(AGY_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(modelsResult)) {
    const error = modelsResult.failure;
    yield* Effect.logWarning("Antigravity CLI model discovery failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Antigravity CLI is installed but model discovery failed. Check server logs for details.",
      },
    });
  }

  if (Option.isNone(modelsResult.success)) {
    yield* Effect.logWarning(
      `Antigravity CLI model discovery timed out after ${AGY_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Antigravity CLI is installed but model discovery timed out after ${AGY_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const modelsOutput = modelsResult.success.value;
  if (modelsOutput.code !== 0) {
    yield* Effect.logWarning("Antigravity CLI models command exited with a non-zero status.", {
      exitCode: modelsOutput.code,
      stdoutLength: modelsOutput.stdout.length,
      stderrLength: modelsOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but model discovery failed.",
      },
    });
  }

  const discoveredModels = parseAgyModelsOutput(modelsOutput.stdout);
  const models =
    discoveredModels.length > 0
      ? providerModelsFromSettings(
          discoveredModels,
          settings.customModels ?? [],
          EMPTY_CAPABILITIES,
        )
      : fallbackModels;

  return buildServerProvider({
    presentation: AGY_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichAgySnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Agy version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
