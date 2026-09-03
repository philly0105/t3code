import {
  type AgySettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type AgyAdapterShape } from "../Services/AgyAdapter.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { parseAgyUsageReport, parseJsonOrUndefined } from "../providerUsage.ts";
import { restoreAgyCredentialProfile, withAgyAccountLock } from "../agy/AgyCredentialProfile.ts";
import { type AgyProcess, makeAgyProcess } from "../agy/AgySessionRuntime.ts";
import {
  agyResultToRuntimeEvents,
  agyStepToRuntimeEvents,
  type AgyEventContext,
} from "../agy/AgyRuntimeEvents.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("agy");
const AGY_RESUME_VERSION = 1 as const;

export interface AgyAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface SessionState {
  readonly threadId: ThreadId;
  session: ProviderSession;
  cwd: string;
  model: string | undefined;
  interactionMode: "default" | "plan";
  conversationId: string | undefined;
  process: AgyProcess | undefined;
  pumpFiber: Fiber.Fiber<void, unknown> | undefined;
  spawnGeneration: number;
  stopped: boolean;
  readonly scope: Scope.Closeable;
  activeTurn:
    | {
        turnId: TurnId;
        deferred: Deferred.Deferred<void, ProviderAdapterProcessError>;
      }
    | undefined;
}

const ResumeCursorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(AGY_RESUME_VERSION),
  conversationId: Schema.optional(Schema.String),
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursorSchema);

export function makeAgyAdapter(settings: AgySettings, options?: AgyAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("agy");
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const environment = options?.environment ?? process.env;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;

    const sessions = new Map<ThreadId, SessionState>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Agy runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const nativeEventLogger = options?.nativeEventLogger;

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Agy notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const stopSessionInternal = (state: SessionState) =>
      Effect.gen(function* () {
        if (state.stopped) return;
        state.stopped = true;
        state.spawnGeneration += 1;
        if (state.activeTurn) {
          yield* Deferred.fail(
            state.activeTurn.deferred,
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: state.threadId,
              detail: "Session stopped",
            }),
          ).pipe(Effect.ignore);
          state.activeTurn = undefined;
        }
        if (state.pumpFiber) {
          yield* Fiber.interrupt(state.pumpFiber).pipe(Effect.ignore);
          state.pumpFiber = undefined;
        }
        // Ordering matters: state is marked stopped and Scope.close is awaited before deleting from
        // sessions so all pumps forked in state.scope exit and bail on stopped before a replacement session can reuse the threadId.
        yield* Effect.ignore(Scope.close(state.scope, Exit.void));
        sessions.delete(state.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: state.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: AgyAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const now = yield* nowIso;
          let conversationId: string | undefined = undefined;
          if (input.resumeCursor) {
            const decodeResult = decodeResumeCursor(input.resumeCursor);
            if (Option.isSome(decodeResult)) {
              conversationId = decodeResult.value.conversationId;
            }
          }

          // agy cannot express approvals at all (its `control_request` answers "not supported yet"),
          // so plan mode is the closest available stand-in for "don't act without asking me".
          const interactionMode = input.runtimeMode === "approval-required" ? "plan" : "default";

          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: AGY_RESUME_VERSION,
              ...(conversationId ? { conversationId } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          const sessionScope = yield* Scope.make("sequential");

          const state: SessionState = {
            threadId: input.threadId,
            session,
            cwd,
            model: input.modelSelection?.model,
            interactionMode,
            conversationId,
            process: undefined,
            pumpFiber: undefined,
            spawnGeneration: 0,
            stopped: false,
            activeTurn: undefined,
            scope: sessionScope,
          };

          sessions.set(input.threadId, state);

          return session;
        }),
      );

    const stopSession: AgyAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state || state.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          yield* stopSessionInternal(state);
        }),
      );

    const sendTurn: AgyAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, ProviderAdapterProcessError>();
        const turnId = TurnId.make(yield* randomUUIDv4);

        const agyProcess = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const state = sessions.get(input.threadId);
            if (!state || state.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }

            if (state.activeTurn) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "A turn is already active",
              });
            }

            if (input.interactionMode !== undefined) {
              const targetMode =
                state.session.runtimeMode === "approval-required" ? "plan" : input.interactionMode;
              if (targetMode !== state.interactionMode) {
                state.interactionMode = targetMode;
                if (state.process) {
                  state.spawnGeneration += 1;
                  yield* state.process.kill();
                  state.process = undefined;
                  if (state.pumpFiber) {
                    yield* Fiber.interrupt(state.pumpFiber).pipe(Effect.ignore);
                    state.pumpFiber = undefined;
                  }
                }
              }
            }

            let agyProcess = state.process;
            let pumpFiber = state.pumpFiber;
            if (!agyProcess) {
              state.spawnGeneration += 1;
              const currentGeneration = state.spawnGeneration;

              const spawnAgyProcess = makeAgyProcess({
                settings,
                cwd: state.cwd,
                environment: environment as NodeJS.ProcessEnv,
                ...(state.model ? { model: state.model } : {}),
                ...(state.interactionMode ? { interactionMode: state.interactionMode } : {}),
                ...(state.conversationId ? { conversationId: state.conversationId } : {}),
              }).pipe(
                Effect.provideService(Scope.Scope, state.scope),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to spawn agy process",
                      cause,
                    }),
                ),
              );

              // agy takes its account from a machine-wide credential entry it
              // reads once at startup, so the profile has to be restored on
              // every spawn — a respawn after a mode change or crash would
              // otherwise pick up whichever account another instance left
              // behind — and spawns have to be serialized while it does.
              const credentialProfile = settings.credentialProfile;
              agyProcess = credentialProfile
                ? yield* withAgyAccountLock(
                    Effect.gen(function* () {
                      const restored = yield* restoreAgyCredentialProfile({
                        profile: credentialProfile,
                        environment: environment as NodeJS.ProcessEnv,
                      }).pipe(
                        Effect.provideService(FileSystem.FileSystem, fileSystem),
                        Effect.provideService(Path.Path, path),
                        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                        Effect.mapError(
                          (cause) =>
                            new ProviderAdapterProcessError({
                              provider: PROVIDER,
                              threadId: input.threadId,
                              detail: cause.detail,
                              cause,
                            }),
                        ),
                      );
                      yield* Effect.logInfo("Restored Antigravity account profile.", {
                        profile: credentialProfile,
                        email: restored.email,
                        switched: restored.switched,
                      });
                      return yield* spawnAgyProcess;
                    }),
                  )
                : yield* spawnAgyProcess;

              pumpFiber = yield* Stream.runDrain(
                Stream.mapEffect(agyProcess.lines, (line) =>
                  Effect.gen(function* () {
                    const currentState = sessions.get(input.threadId);
                    if (
                      !currentState ||
                      currentState.stopped ||
                      currentState.spawnGeneration !== currentGeneration
                    ) {
                      return;
                    }
                    const activeTurn = currentState.activeTurn;
                    const activeTurnId = activeTurn?.turnId;

                    const context: AgyEventContext = {
                      threadId: input.threadId,
                      turnId: activeTurnId,
                      providerInstanceId: boundInstanceId,
                    };

                    if (line._tag === "Init") {
                      yield* logNative(input.threadId, "agy.init", line);
                      const stamp = yield* makeEventStamp();
                      currentState.conversationId = line.conversationId;
                      currentState.session = {
                        ...currentState.session,
                        updatedAt: stamp.createdAt,
                        resumeCursor: {
                          ...(typeof currentState.session.resumeCursor === "object" &&
                          currentState.session.resumeCursor !== null
                            ? currentState.session.resumeCursor
                            : { schemaVersion: AGY_RESUME_VERSION }),
                          conversationId: line.conversationId,
                        },
                      };
                    } else if (line._tag === "Step") {
                      yield* logNative(input.threadId, "agy.step", line);
                      const events = agyStepToRuntimeEvents(context, line.step);
                      for (const event of events) {
                        const eventStamp = yield* makeEventStamp();
                        yield* offerRuntimeEvent({ ...event, ...eventStamp });
                      }
                    } else if (line._tag === "Result") {
                      yield* logNative(input.threadId, "agy.result", line);
                      const events = agyResultToRuntimeEvents(context, line.result);
                      for (const event of events) {
                        const eventStamp = yield* makeEventStamp();
                        yield* offerRuntimeEvent({ ...event, ...eventStamp });
                      }

                      if (activeTurn && currentState.activeTurn === activeTurn) {
                        yield* Deferred.succeed(activeTurn.deferred, undefined);
                      }
                    }
                  }),
                ),
              ).pipe(
                Effect.catchTag("AgyProcessError", (cause) =>
                  Effect.gen(function* () {
                    const currentState = sessions.get(input.threadId);
                    if (
                      !currentState ||
                      currentState.stopped ||
                      currentState.spawnGeneration !== currentGeneration
                    ) {
                      return;
                    }
                    const stamp = yield* makeEventStamp();
                    const activeTurn = currentState.activeTurn;

                    yield* offerRuntimeEvent({
                      type: "runtime.error",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: input.threadId,
                      ...(activeTurn ? { turnId: activeTurn.turnId } : {}),
                      payload: {
                        message: `Agy process error: ${
                          typeof cause === "object" && cause !== null && "detail" in cause
                            ? String((cause as { detail?: unknown }).detail)
                            : String(cause)
                        }`,
                      },
                    });

                    if (activeTurn && currentState.activeTurn === activeTurn) {
                      yield* Deferred.fail(
                        activeTurn.deferred,
                        new ProviderAdapterProcessError({
                          provider: PROVIDER,
                          threadId: input.threadId,
                          detail: "Agy process error",
                          cause,
                        }),
                      );
                    }
                  }),
                ),
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    const currentState = sessions.get(input.threadId);
                    if (
                      !currentState ||
                      currentState.stopped ||
                      currentState.spawnGeneration !== currentGeneration
                    ) {
                      return;
                    }
                    const activeTurn = currentState.activeTurn;
                    if (activeTurn && currentState.activeTurn === activeTurn) {
                      yield* Deferred.fail(
                        activeTurn.deferred,
                        new ProviderAdapterProcessError({
                          provider: PROVIDER,
                          threadId: input.threadId,
                          detail: "Pump exited",
                          cause: Exit.isFailure(exit) ? exit.cause : undefined,
                        }),
                      ).pipe(Effect.ignore);
                    }
                    if (currentState.process === agyProcess) {
                      currentState.process = undefined;
                    }
                    if (currentState.pumpFiber === pumpFiber) {
                      currentState.pumpFiber = undefined;
                    }
                  }),
                ),
                Effect.forkIn(state.scope),
              );
            }

            state.process = agyProcess;
            state.pumpFiber = pumpFiber;
            state.activeTurn = { turnId, deferred };

            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {},
            });

            return agyProcess;
          }),
        );

        yield* Effect.gen(function* () {
          yield* agyProcess.sendTurn(input.input || "").pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to send turn",
                  cause,
                }),
            ),
          );

          yield* Deferred.await(deferred);
        }).pipe(
          Effect.ensuring(
            withThreadLock(
              input.threadId,
              Effect.sync(() => {
                const state = sessions.get(input.threadId);
                if (state && state.activeTurn?.turnId === turnId) {
                  state.activeTurn = undefined;
                }
              }),
            ),
          ),
        );

        // The conversation id only arrives on the `init` line, after the turn is
        // under way, so it has to be handed back here. Without it the next
        // startSession resumes nothing, agy opens a fresh conversation, and its
        // step indices restart — which collides item ids across turns.
        const settled = sessions.get(input.threadId);
        return {
          threadId: input.threadId,
          turnId,
          ...(settled ? { resumeCursor: settled.session.resumeCursor } : {}),
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: AgyAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state || state.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }

          if (state.activeTurn) {
            yield* offerRuntimeEvent({
              type: "turn.aborted",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: state.activeTurn.turnId,
              payload: { reason: "interrupted" },
            });

            yield* Deferred.fail(
              state.activeTurn.deferred,
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: "Turn interrupted",
              }),
            ).pipe(Effect.ignore);
          }

          // Bump the generation before killing so the dying pump's handlers bail immediately
          // rather than publishing a runtime.error or a late content.delta for the aborted turn.
          state.spawnGeneration += 1;

          if (state.process) {
            yield* state.process.kill();
            state.process = undefined;
          }
          if (state.pumpFiber) {
            yield* Fiber.interrupt(state.pumpFiber).pipe(Effect.ignore);
            state.pumpFiber = undefined;
          }

          state.activeTurn = undefined;
        }),
      );

    const respondToRequest: AgyAdapterShape["respondToRequest"] = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Agy does not emit requests.",
        }),
      );

    const respondToUserInput: AgyAdapterShape["respondToUserInput"] = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Agy does not emit requests.",
        }),
      );

    const readThread: AgyAdapterShape["readThread"] = (threadId) =>
      Effect.succeed({ threadId, turns: [] });

    const rollbackThread: AgyAdapterShape["rollbackThread"] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Agy exposes no thread-history read/rollback API.",
        }),
      );

    const hasSession: AgyAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const s = sessions.get(threadId);
        return s !== undefined && !s.stopped;
      });

    const listSessions: AgyAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((state) => !state.stopped)
          .map((state) => state.session),
      );

    const stopAll: AgyAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (state) => withThreadLock(state.threadId, stopSessionInternal(state)),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.timeout(2000),
        Effect.ignore,
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    // `agy -p /usage` is answered by the CLI itself rather than by the model:
    // no turn, no tokens, no conversation left behind. The answer is per
    // account, so it needs the same credential dance as a session spawn.
    const runUsageCommand = Effect.gen(function* () {
      const binaryPath = settings.binaryPath || "agy";
      const spawnCommand = yield* resolveSpawnCommand(
        binaryPath,
        ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"],
        { env: environment },
      );
      const result = yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          stdin: "ignore",
        }),
      );
      return result.stdout;
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readUsage",
            detail: "Failed to run `agy -p /usage`.",
            cause,
          }),
      ),
    );

    const readUsage: AgyAdapterShape["readUsage"] = () =>
      Effect.gen(function* () {
        const credentialProfile = settings.credentialProfile;
        const stdout = credentialProfile
          ? yield* withAgyAccountLock(
              Effect.gen(function* () {
                yield* restoreAgyCredentialProfile({
                  profile: credentialProfile,
                  environment: environment as NodeJS.ProcessEnv,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "readUsage",
                        detail: cause.detail,
                        cause,
                      }),
                  ),
                );
                return yield* runUsageCommand;
              }),
            )
          : yield* runUsageCommand;

        const reading = parseAgyUsageReport(parseJsonOrUndefined(stdout));
        if (!reading) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readUsage",
            detail: "Antigravity reported no account limits.",
          });
        }
        return reading;
      });

    return {
      provider: PROVIDER,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      capabilities: { sessionModelSwitch: "unsupported" },
      readUsage,
      startSession,
      stopSession,
      stopAll,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread,
      hasSession,
      listSessions,
    } satisfies AgyAdapterShape;
  });
}
