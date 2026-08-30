// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AgySettings,
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makeMockAgyBinary } from "../agy/testSupport.ts";
import { makeAgyAdapter } from "./AgyAdapter.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);
const threadId = ThreadId.make("thread_agy_1");
const instanceId = ProviderInstanceId.make("agy");

it.effect("streams a turn end to end and completes it", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockAgyBinary());
    const adapter = yield* makeAgyAdapter(decodeAgySettings({ enabled: true, binaryPath }), {
      environment: { ...process.env, AGY_MOCK_TOOL_NAME: "run_command" },
      instanceId,
    });

    const collected = yield* Effect.forkChild(
      Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "turn.completed")),
      ),
    );

    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hi" });

    const events = Array.from(yield* Fiber.join(collected)) as Array<ProviderRuntimeEvent>;
    const types = events.map((event) => event.type);

    assert.include(types, "turn.started");
    assert.include(types, "item.updated");
    assert.include(types, "content.delta");
    assert.strictEqual(types.at(-1), "turn.completed");

    const delta = events.find((event) => event.type === "content.delta");
    assert.strictEqual((delta?.payload as { delta: string }).delta, "echo:");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("declares model switching unsupported and rejects approvals", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockAgyBinary());
    const adapter = yield* makeAgyAdapter(decodeAgySettings({ enabled: true, binaryPath }), {
      environment: process.env,
      instanceId,
    });

    assert.strictEqual(adapter.capabilities.sessionModelSwitch, "unsupported");

    const outcome = yield* Effect.result(
      adapter.respondToRequest(threadId, ApprovalRequestId.make("req_1"), "accept"),
    );
    assert.strictEqual(outcome._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports no session before start and none after stop, tearing child down", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockAgyBinary());
    const adapter = yield* makeAgyAdapter(decodeAgySettings({ enabled: true, binaryPath }), {
      environment: process.env,
      instanceId,
    });

    assert.isFalse(yield* adapter.hasSession(threadId));
    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
    assert.isTrue(yield* adapter.hasSession(threadId));
    assert.strictEqual((yield* adapter.listSessions()).length, 1);

    // Send a turn to ensure the child process and pump fiber are actively spawned
    yield* adapter.sendTurn({ threadId, input: "init-turn" });

    // Collect session.exited event on stop
    const exitedFiber = yield* Effect.forkChild(
      Stream.runHead(
        adapter.streamEvents.pipe(
          Stream.filter((e) => e.type === "session.exited" && e.threadId === threadId),
        ),
      ),
    );

    yield* adapter.stopSession(threadId);

    const exitedEvent = yield* Fiber.join(exitedFiber);
    assert.isTrue(exitedEvent._tag === "Some");
    if (exitedEvent._tag === "Some") {
      assert.strictEqual(exitedEvent.value.type, "session.exited");
      assert.strictEqual(
        (exitedEvent.value.payload as { exitKind?: string })?.exitKind,
        "graceful",
      );
    }

    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.strictEqual((yield* adapter.listSessions()).length, 0);

    // Stopping again fails with ProviderAdapterSessionNotFoundError
    const stopAgainError = yield* Effect.flip(adapter.stopSession(threadId));
    assert.strictEqual(stopAgainError._tag, "ProviderAdapterSessionNotFoundError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("handles a second turn on the same session across a single subscription", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockAgyBinary());
    const adapter = yield* makeAgyAdapter(decodeAgySettings({ enabled: true, binaryPath }), {
      environment: process.env,
      instanceId,
    });

    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });

    let completedTurns = 0;
    const collectedEventsFiber = yield* Effect.forkChild(
      Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.filter((e) => e.threadId === threadId),
          Stream.takeUntil((e) => {
            if (e.type === "turn.completed") {
              completedTurns += 1;
              return completedTurns === 2;
            }
            return false;
          }),
        ),
      ),
    );

    yield* adapter.sendTurn({ threadId, input: "first" });
    yield* adapter.sendTurn({ threadId, input: "second" });

    const allEvents = Array.from(
      yield* Fiber.join(collectedEventsFiber),
    ) as Array<ProviderRuntimeEvent>;
    const turnCompletedEvents = allEvents.filter((e) => e.type === "turn.completed");
    assert.strictEqual(turnCompletedEvents.length, 2);

    const turnStartedEvents = allEvents.filter((e) => e.type === "turn.started");
    assert.strictEqual(turnStartedEvents.length, 2);

    // Verify step indexing monotonically increments on the same process
    const deltas = allEvents.filter((e) => e.type === "content.delta");
    const deltaItems = deltas.map((e) => e.itemId);
    assert.isTrue(deltaItems.some((id) => id === "agy-step-1"));
    assert.isTrue(deltaItems.some((id) => id === "agy-step-2"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Needs live clock because it depends on wall-clock timing to interrupt a sleeping child process
it.live("interrupts a turn and allows a follow-up turn", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    // Script emits 'init', an active step, then hangs for 500ms
    const crashScript =
      process.platform === "win32" ? NodePath.join(dir, "hang.cmd") : NodePath.join(dir, "hang.sh");

    const nodeFile = NodePath.join(dir, "script.js");
    yield* fs.writeFileString(
      nodeFile,
      `
      console.log(JSON.stringify({event:"init",conversation_id:"mock-conv-2",init:{runtime_mode:"full-access"}}));
      console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"mock-conv-2",step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"working..."}}));
      setTimeout(() => process.exit(0), 500);
    `,
    );

    const win32Script = `@echo off\r\n"${process.execPath}" "${nodeFile}"\r\n`;
    const unixScript = `#!/bin/sh\n"${process.execPath}" "${nodeFile}"\n`;

    yield* fs.writeFileString(
      crashScript,
      process.platform === "win32" ? win32Script : unixScript,
      { mode: 0o755 },
    );

    const adapter = yield* makeAgyAdapter(
      decodeAgySettings({ enabled: true, binaryPath: crashScript }),
      {
        environment: process.env,
        instanceId,
      },
    );

    const events: Array<ProviderRuntimeEvent> = [];
    const eventCollectorFiber = yield* Effect.forkChild(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.threadId === threadId) {
            events.push(event);
          }
        }),
      ),
    );

    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });

    // Wait event-driven for the active step delta to arrive before interrupting
    const waitForTurn1Delta = Stream.runHead(
      adapter.streamEvents.pipe(
        Stream.filter((e) => e.type === "content.delta" && e.threadId === threadId),
      ),
    );
    const delta1Fiber = yield* Effect.forkChild(waitForTurn1Delta);
    const sendFiber1 = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hang1" }));
    yield* Fiber.join(delta1Fiber);

    // Verify conversationId was captured on session state
    const sessions = yield* adapter.listSessions();
    assert.strictEqual(sessions.length, 1);
    const resumeCursor = sessions[0]!.resumeCursor as { schemaVersion: 1; conversationId?: string };
    assert.strictEqual(resumeCursor.conversationId, "mock-conv-2");

    // Interrupt turn 1
    yield* adapter.interruptTurn(threadId);

    // sendTurn 1 should fail specifically with "Turn interrupted" (not "Pump exited")
    const err1 = yield* Effect.flip(Fiber.join(sendFiber1));
    assert.strictEqual(err1._tag, "ProviderAdapterProcessError");
    if (err1._tag === "ProviderAdapterProcessError") {
      assert.strictEqual(err1.detail, "Turn interrupted");
    }

    // Second turn should be allowed to start cleanly
    const waitForTurn2Delta = Stream.runHead(
      adapter.streamEvents.pipe(
        Stream.filter((e) => e.type === "content.delta" && e.threadId === threadId),
      ),
    );
    const delta2Fiber = yield* Effect.forkChild(waitForTurn2Delta);
    const sendFiber2 = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hang2" }));
    yield* Fiber.join(delta2Fiber);

    // Interrupt turn 2
    yield* adapter.interruptTurn(threadId);

    // sendTurn 2 should also fail specifically with "Turn interrupted" (not "Pump exited" or stale clobber)
    const err2 = yield* Effect.flip(Fiber.join(sendFiber2));
    assert.strictEqual(err2._tag, "ProviderAdapterProcessError");
    if (err2._tag === "ProviderAdapterProcessError") {
      assert.strictEqual(err2.detail, "Turn interrupted");
    }

    yield* Fiber.interrupt(eventCollectorFiber);

    const abortedEvents = events.filter((e) => e.type === "turn.aborted");
    assert.strictEqual(abortedEvents.length, 2);

    const exitedEvents = events.filter((e) => e.type === "session.exited");
    assert.strictEqual(exitedEvents.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout(5000)),
);

it.effect("fails sendTurn with ProviderAdapterProcessError on mid-turn process death", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const crashScript =
      process.platform === "win32"
        ? NodePath.join(dir, "crash.cmd")
        : NodePath.join(dir, "crash.sh");

    const win32Script = `@echo off\r\necho {"event":"init","conversation_id":"mock-conv-3","init":{"runtime_mode":"full-access"}}\r\nexit 1\r\n`;
    const unixScript = `#!/bin/sh\necho '{"event":"init","conversation_id":"mock-conv-3","init":{"runtime_mode":"full-access"}}'\nexit 1\n`;

    yield* fs.writeFileString(
      crashScript,
      process.platform === "win32" ? win32Script : unixScript,
      { mode: 0o755 },
    );

    const adapter = yield* makeAgyAdapter(
      decodeAgySettings({ enabled: true, binaryPath: crashScript }),
      {
        environment: process.env,
        instanceId,
      },
    );

    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });

    const err = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hello" }));
    assert.strictEqual(err._tag, "ProviderAdapterProcessError");
    if (err._tag === "ProviderAdapterProcessError") {
      assert.strictEqual(err.detail, "Pump exited");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
