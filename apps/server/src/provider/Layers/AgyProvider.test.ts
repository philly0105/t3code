import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgySettings } from "@t3tools/contracts";

import { checkAgyProviderStatus, parseAgyModelsOutput } from "./AgyProvider.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);

describe("parseAgyModelsOutput", () => {
  it("parses tab-separated slug and display name, skipping the fetch header", () => {
    const models = parseAgyModelsOutput(
      [
        "Fetching available models...",
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );
    expect(models.map((model) => model.slug)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
    ]);
    expect(models[0]?.name).toBe("Gemini 3.7 Flash (High)");
    expect(models[0]?.isCustom).toBe(false);
  });

  it("falls back to the slug when no display name is present", () => {
    const models = parseAgyModelsOutput("gemini-3.7-flash-low");
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("gemini-3.7-flash-low");
  });

  it("returns an empty list for blank or header-only output", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
    expect(parseAgyModelsOutput("Fetching available models...")).toEqual([]);
  });

  it("returns an empty list for output containing a human sentence", () => {
    const models = parseAgyModelsOutput("You are not signed in. Run 'agy login' to continue.");
    expect(models).toEqual([]);
  });
});

// Writes a throwaway `agy` stub into a scoped temp dir and returns its path. CI runs Linux and
// developers run Windows, so each caller supplies both script bodies.
const writeAgyStub = (prefix: string, win32: ReadonlyArray<string>, unix: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    const isWin32 = process.platform === "win32";
    const agyPath = path.join(dir, isWin32 ? "agy.cmd" : "agy.sh");
    yield* fs.writeFileString(
      agyPath,
      isWin32 ? `${win32.join("\r\n")}\r\n` : `${unix.join("\n")}\n`,
      { mode: 0o755 },
    );
    return agyPath;
  });

it.layer(NodeServices.layer)("checkAgyProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAgyProviderStatus(
        decodeAgySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/agy-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      // Printed to stdout on purpose: the defect this pins was raw stdout reaching `version`.
      const secretOutput = "broken agy install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const agyPath = yield* writeAgyStub(
            "t3code-agy-version-",
            [`@echo off`, `echo ${secretOutput}`, `exit /b 2`],
            [`#!/bin/sh`, `echo "${secretOutput}"`, `exit 2`],
          );

          return yield* checkAgyProviderStatus(
            decodeAgySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toBe("Antigravity CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretOutput);
    }),
  );

  it.effect("falls back to settings custom models when agy models exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const agyPath = yield* writeAgyStub(
            "t3code-agy-models-fail-",
            [
              `@echo off`,
              `if "%~1"=="--version" (`,
              `  echo 1.1.22`,
              `  exit /b 0`,
              `)`,
              `exit /b 2`,
            ],
            [
              `#!/bin/sh`,
              `if [ "$1" = "--version" ]; then`,
              `  echo 1.1.22`,
              `  exit 0`,
              `fi`,
              `exit 2`,
            ],
          );

          return yield* checkAgyProviderStatus(
            decodeAgySettings({
              enabled: true,
              binaryPath: agyPath,
              customModels: ["custom-model-1"],
            }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.1.22");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["custom-model-1"]);
    }),
  );

  it.effect("merges custom models from settings with successful model discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const agyPath = yield* writeAgyStub(
            "t3code-agy-success-",
            [
              `@echo off`,
              `if "%~1"=="--version" (`,
              `  echo 1.1.22`,
              `  exit /b 0`,
              `)`,
              `echo discovered-model-1`,
              `exit /b 0`,
            ],
            [
              `#!/bin/sh`,
              `if [ "$1" = "--version" ]; then`,
              `  echo 1.1.22`,
              `  exit 0`,
              `fi`,
              `echo discovered-model-1`,
              `exit 0`,
            ],
          );

          return yield* checkAgyProviderStatus(
            decodeAgySettings({
              enabled: true,
              binaryPath: agyPath,
              customModels: ["custom-model-1"],
            }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.1.22");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "discovered-model-1",
        "custom-model-1",
      ]);
    }),
  );

  // The real `agy models` reads stdin to EOF before printing, so leaving the
  // default stdin pipe open hangs discovery until the timeout. This stub blocks
  // the same way; it only completes because the probe closes stdin.
  it.effect("completes discovery when the CLI drains stdin before printing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const agyPath = yield* writeAgyStub(
            "t3code-agy-stdin-",
            [
              `@echo off`,
              `if "%~1"=="--version" (`,
              `  echo 1.1.22`,
              `  exit /b 0`,
              `)`,
              `set /p AGY_STDIN_PROBE=`,
              `echo discovered-model-1`,
              `exit /b 0`,
            ],
            [
              `#!/bin/sh`,
              `if [ "$1" = "--version" ]; then`,
              `  echo 1.1.22`,
              `  exit 0`,
              `fi`,
              `cat > /dev/null`,
              `echo discovered-model-1`,
              `exit 0`,
            ],
          );

          return yield* checkAgyProviderStatus(
            decodeAgySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["discovered-model-1"]);
    }),
  );
});
