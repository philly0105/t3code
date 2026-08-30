// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

it.effect("reports no session before start and none after stop", () =>
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

    yield* adapter.stopSession(threadId);
    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
