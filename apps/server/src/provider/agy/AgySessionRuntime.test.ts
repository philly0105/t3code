// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AgySettings } from "@t3tools/contracts";

import { buildAgyLaunchArgs, makeAgyProcess } from "./AgySessionRuntime.ts";
import { makeMockAgyBinary } from "./testSupport.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);

it("attaches the prompt flag with = and never as a bare argument", () => {
  const args = buildAgyLaunchArgs({ model: "gemini-3.7-flash-high", interactionMode: "plan" });
  assert.include(args, "--print=");
  assert.notInclude(args, "-p");
  assert.notInclude(args, "--print");
  assert.include(args, "--mode");
  assert.include(args, "plan");
  assert.include(args, "--dangerously-skip-permissions");
});

it("overrides the 5m print-mode timeout that would cut long turns short", () => {
  const args = buildAgyLaunchArgs({});
  const index = args.indexOf("--print-timeout");
  assert.isAtLeast(index, 0);
  assert.strictEqual(args[index + 1], "24h");
});

it("passes --conversation when resuming", () => {
  const args = buildAgyLaunchArgs({ conversationId: "conv-9" });
  const index = args.indexOf("--conversation");
  assert.isAtLeast(index, 0);
  assert.strictEqual(args[index + 1], "conv-9");
});

it.effect("streams decoded lines for one turn and reports the conversation id", () =>
  Effect.gen(function* () {
    const binaryPath = yield* makeMockAgyBinary();
    const agyProcess = yield* makeAgyProcess({
      settings: decodeAgySettings({ enabled: true, binaryPath }),
      cwd: NodeOS.tmpdir(),
      environment: { ...process.env, AGY_MOCK_CONVERSATION_ID: "conv-test" },
    });

    const collected = yield* Effect.forkScoped(
      Stream.runCollect(Stream.takeUntil(agyProcess.lines, (line) => line._tag === "Result")),
    );
    yield* agyProcess.sendTurn("hi");
    const lines = Array.from(yield* Fiber.join(collected));

    const tags = lines.map((line) => line._tag);
    assert.strictEqual(tags[0], "Init");
    assert.strictEqual(tags.at(-1), "Result");
    assert.strictEqual(yield* agyProcess.conversationId, "conv-test");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("supports multiple turns on a single subscription and can be killed", () =>
  Effect.gen(function* () {
    const binaryPath = yield* makeMockAgyBinary();
    const agyProcess = yield* makeAgyProcess({
      settings: decodeAgySettings({ enabled: true, binaryPath }),
      cwd: NodeOS.tmpdir(),
      environment: { ...process.env, AGY_MOCK_CONVERSATION_ID: "conv-multi" },
    });

    const collected = yield* Effect.forkScoped(
      agyProcess.lines.pipe(
        Stream.filter((line) => line._tag === "Result"),
        Stream.take(2),
        Stream.runCollect,
      ),
    );

    yield* agyProcess.sendTurn("turn 1");
    yield* agyProcess.sendTurn("turn 2");

    const lines = Array.from(yield* Fiber.join(collected));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0]!._tag, "Result");
    assert.strictEqual(lines[1]!._tag, "Result");

    yield* agyProcess.kill();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
