/**
 * Owns one `agy` child process and exposes its stream-json output as
 * decoded lines. Thread, turn, and event concerns stay in AgyAdapter.
 *
 * @module provider/agy/AgySessionRuntime
 */
import type { AgySettings } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { decodeAgyOutputLine, encodeAgyUserMessage, type AgyOutputLine } from "./AgyStreamJson.ts";

export class AgyProcessError extends Data.TaggedError("AgyProcessError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface AgyProcess {
  readonly sendTurn: (text: string) => Effect.Effect<void, AgyProcessError>;
  /**
   * Stream of decoded output lines from the `agy` process.
   * Note: This stream supports exactly ONE long-lived subscription for the life of the process.
   * Consumers must not re-subscribe per turn.
   */
  readonly lines: Stream.Stream<AgyOutputLine, AgyProcessError>;
  readonly kill: () => Effect.Effect<void>;
  readonly conversationId: Effect.Effect<string | undefined>;
}

/**
 * `agy`'s parser takes the argument after a bare `-p`/`--print` as the
 * prompt, so the flag must be attached with `=`. Everything else may follow
 * in any order.
 */
export function buildAgyLaunchArgs(input: {
  readonly model?: string;
  readonly interactionMode?: "default" | "plan";
  readonly conversationId?: string;
}): ReadonlyArray<string> {
  return [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--mode",
    input.interactionMode === "plan" ? "plan" : "accept-edits",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.conversationId ? ["--conversation", input.conversationId] : []),
  ];
}

export const makeAgyProcess = Effect.fn("makeAgyProcess")(function* (input: {
  readonly settings: AgySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly interactionMode?: "default" | "plan";
  readonly conversationId?: string;
}): Effect.fn.Return<
  AgyProcess,
  AgyProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = input.settings.binaryPath || "agy";
  const args = buildAgyLaunchArgs(input);

  const spawnCommand = yield* resolveSpawnCommand(command, args, {
    env: input.environment,
  }).pipe(
    Effect.mapError((cause) => new AgyProcessError({ detail: `Cannot resolve ${command}`, cause })),
  );

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: input.environment,
        cwd: input.cwd,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new AgyProcessError({ detail: `Failed to spawn ${command}`, cause }),
      ),
    );

  const conversationRef = yield* Ref.make<string | undefined>(input.conversationId);

  const lines = child.stdout.pipe(
    Stream.mapError((cause) => new AgyProcessError({ detail: "agy stdout failed", cause })),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.map(decodeAgyOutputLine),
    Stream.tap((line) =>
      line._tag === "Init" ? Ref.set(conversationRef, line.conversationId) : Effect.void,
    ),
  );

  const stdinQueue = yield* Queue.unbounded<Uint8Array>();
  yield* Stream.fromQueue(stdinQueue).pipe(
    Stream.run(child.stdin),
    Effect.ensuring(Queue.shutdown(stdinQueue)),
    Effect.forkScoped,
  );

  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

  return {
    lines,
    conversationId: Ref.get(conversationRef),
    sendTurn: (text) =>
      Queue.offer(stdinQueue, new TextEncoder().encode(encodeAgyUserMessage(text))).pipe(
        Effect.flatMap((success) =>
          success
            ? Effect.void
            : Effect.fail(
                new AgyProcessError({
                  detail: "Cannot send turn: process queue is closed or process died",
                }),
              ),
        ),
      ),
    kill: () => child.kill().pipe(Effect.ignore),
  };
});
