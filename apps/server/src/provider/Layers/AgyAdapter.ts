import {
  ApprovalRequestId,
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
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Option from "effect/Option";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AgyAdapterShape } from "../Services/AgyAdapter.ts";
import { type AgyProcess, type AgyProcessError, makeAgyProcess } from "../agy/AgySessionRuntime.ts";
import {
  agyResultToRuntimeEvents,
  agyStepToRuntimeEvents,
  type AgyEventContext,
} from "../agy/AgyRuntimeEvents.ts";

const PROVIDER = ProviderDriverKind.make("agy");
const AGY_RESUME_VERSION = 1 as const;

export interface AgyAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface SessionState {
  session: ProviderSession;
  cwd: string;
  model: string | undefined;
  interactionMode: "default" | "plan";
  conversationId: string | undefined;
  process: AgyProcess | undefined;
  pumpFiber: Fiber.Fiber<void, unknown> | undefined;
  scope: Scope.Scope;
  activeTurn:
    | {
        turnId: TurnId;
        deferred: Deferred.Deferred<void, ProviderAdapterProcessError>;
      }
    | undefined;
}

export function makeAgyAdapter(settings: AgySettings, options?: AgyAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("agy");
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const environment = options?.environment ?? process.env;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const sessionsRef = yield* SynchronizedRef.make(new Map<ThreadId, SessionState>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

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

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const stopSessionInternal = (threadId: ThreadId, state: SessionState) =>
      Effect.gen(function* () {
        if (state.process) {
          yield* state.process.kill();
        }
        if (state.pumpFiber) {
          yield* Fiber.interrupt(state.pumpFiber);
        }
        if (state.activeTurn) {
          yield* Deferred.fail(
            state.activeTurn.deferred,
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: "Session stopped",
            }),
          ).pipe(Effect.ignore);
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: AgyAdapterShape["startSession"] = (input) =>
      SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
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
          if (existing) {
            yield* stopSessionInternal(input.threadId, existing);
          }

          const now = yield* nowIso;
          let conversationId: string | undefined = undefined;
          if (
            input.resumeCursor &&
            typeof input.resumeCursor === "object" &&
            "conversationId" in input.resumeCursor
          ) {
            conversationId = (input.resumeCursor as any).conversationId as string;
          }

          const interactionMode = input.runtimeMode === "full-access" ? "plan" : "default";

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
            session,
            cwd,
            model: input.modelSelection?.model, // The model is a launch flag
            interactionMode,
            conversationId,
            process: undefined,
            pumpFiber: undefined,
            activeTurn: undefined,
            scope: sessionScope,
          };

          const nextSessions = new Map(sessions);
          nextSessions.set(input.threadId, state);
          return [session, nextSessions] as const;
        }),
      );

    const stopSession: AgyAdapterShape["stopSession"] = (threadId) =>
      SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (state) {
            yield* stopSessionInternal(threadId, state);
            const nextSessions = new Map(sessions);
            nextSessions.delete(threadId);
            return [undefined, nextSessions] as const;
          }
          return [undefined, sessions] as const;
        }),
      );

    const sendTurn: AgyAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, ProviderAdapterProcessError>();

        const turnId = TurnId.make(yield* randomUUIDv4);

        const agyProcess = yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
          Effect.gen(function* () {
            const state = sessions.get(input.threadId);
            if (!state) {
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

            let agyProcess = state.process;
            let pumpFiber = state.pumpFiber;
            if (!agyProcess) {
              // Lazily spawn
              // @ts-expect-error Type ProcessEnv differs slightly depending on how node types are resolved
              agyProcess = yield* makeAgyProcess({
                settings,
                cwd: state.cwd,
                environment,
                model: state.model,
                interactionMode: state.interactionMode,
                conversationId: state.conversationId,
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

              pumpFiber = yield* Stream.runDrain(
                Stream.mapEffect(agyProcess.lines, (line) =>
                  Effect.gen(function* () {
                    const stamp = yield* makeEventStamp();
                    const stateSnapshot = yield* SynchronizedRef.get(sessionsRef);
                    const currentState = stateSnapshot.get(input.threadId);
                    const activeTurnId = currentState?.activeTurn?.turnId;

                    const context: AgyEventContext = {
                      stamp,
                      threadId: input.threadId,
                      turnId: activeTurnId,
                      providerInstanceId: boundInstanceId,
                    };

                    if (line._tag === "Init") {
                      yield* SynchronizedRef.update(sessionsRef, (s) => {
                        const ctx = s.get(input.threadId);
                        if (ctx) {
                          const next = new Map(s);
                          next.set(input.threadId, { ...ctx, conversationId: line.conversationId });
                          return next;
                        }
                        return s;
                      });
                    } else if (line._tag === "Step") {
                      const events = agyStepToRuntimeEvents(context, line.step);
                      for (const event of events) {
                        yield* offerRuntimeEvent(event);
                      }
                    } else if (line._tag === "Result") {
                      const events = agyResultToRuntimeEvents(context, line.result);
                      for (const event of events) {
                        yield* offerRuntimeEvent(event);
                      }

                      // Complete the active turn
                      if (currentState?.activeTurn) {
                        yield* Deferred.succeed(currentState.activeTurn.deferred, undefined);
                      }
                    }
                  }),
                ),
              ).pipe(
                Effect.catchTag("AgyProcessError", (cause) =>
                  Effect.gen(function* () {
                    // Handle AgyProcessError
                    const stateSnapshot = yield* SynchronizedRef.get(sessionsRef);
                    const currentState = stateSnapshot.get(input.threadId);
                    const stamp = yield* makeEventStamp();

                    yield* offerRuntimeEvent({
                      type: "runtime.error",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: input.threadId,
                      ...(currentState?.activeTurn
                        ? { turnId: currentState.activeTurn.turnId }
                        : {}),
                      payload: {
                        message: `Agy process error: ${(cause as any)?.detail || String(cause)}`,
                      },
                    });

                    if (currentState?.activeTurn) {
                      yield* Deferred.fail(
                        currentState.activeTurn.deferred,
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
                Effect.forkIn(state.scope),
              );
            }

            const nextState: SessionState = {
              ...state,
              process: agyProcess,
              pumpFiber,
              activeTurn: { turnId, deferred },
            };

            const nextSessions = new Map(sessions);
            nextSessions.set(input.threadId, nextState);

            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {},
            });

            return [agyProcess, nextSessions] as const;
          }),
        );

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

        yield* SynchronizedRef.update(sessionsRef, (sessions) => {
          const state = sessions.get(input.threadId);
          if (state) {
            const next = new Map(sessions);
            next.set(input.threadId, { ...state, activeTurn: undefined });
            return next;
          }
          return sessions;
        });

        return { threadId: input.threadId, turnId } as ProviderTurnStartResult;
      });

    const interruptTurn: AgyAdapterShape["interruptTurn"] = (threadId) =>
      SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }

          if (state.process) {
            yield* state.process.kill();
          }
          if (state.pumpFiber) {
            yield* Fiber.interrupt(state.pumpFiber);
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

          const nextState: SessionState = {
            ...state,
            process: undefined,
            pumpFiber: undefined,
            activeTurn: undefined,
          };

          const nextSessions = new Map(sessions);
          nextSessions.set(threadId, nextState);
          return [undefined, nextSessions] as const;
        }),
      );

    const respondToRequest: AgyAdapterShape["respondToRequest"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Agy does not emit requests.",
        }),
      );

    const respondToUserInput: AgyAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Agy does not emit requests.",
        }),
      );

    const readThread: AgyAdapterShape["readThread"] = (threadId) =>
      Effect.succeed({ threadId, turns: [] });

    const rollbackThread: AgyAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Agy exposes no thread-history read/rollback API.",
        }),
      );

    const hasSession: AgyAdapterShape["hasSession"] = (threadId) =>
      SynchronizedRef.get(sessionsRef).pipe(Effect.map((s) => s.has(threadId)));

    const listSessions: AgyAdapterShape["listSessions"] = () =>
      SynchronizedRef.get(sessionsRef).pipe(
        Effect.map((s) => Array.from(s.values()).map((state) => state.session)),
      );

    const stopAll: AgyAdapterShape["stopAll"] = () =>
      SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
        Effect.gen(function* () {
          for (const state of Array.from(sessions.values())) {
            yield* stopSessionInternal(state.session.threadId, state);
          }
          return [undefined, new Map()] as const;
        }),
      );

    return {
      provider: PROVIDER,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      capabilities: { sessionModelSwitch: "unsupported" },
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
    } as AgyAdapterShape;
  });
}
