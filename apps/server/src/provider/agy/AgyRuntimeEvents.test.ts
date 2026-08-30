import { describe, expect, it } from "vitest";

import { EventId, ThreadId, TurnId } from "@t3tools/contracts";

import { agyResultToRuntimeEvents, agyStepToRuntimeEvents } from "./AgyRuntimeEvents.ts";
import type { AgyResult, AgyStep } from "./AgyStreamJson.ts";

const context = {
  stamp: { eventId: EventId.make("evt_1"), createdAt: "2026-08-30T00:00:00.000Z" },
  threadId: ThreadId.make("thread_1"),
  turnId: TurnId.make("turn_1"),
  providerInstanceId: undefined,
};

const step = (overrides: Partial<AgyStep>): AgyStep => ({
  conversationId: "conv_1",
  stepIndex: 1,
  state: "ACTIVE",
  stepType: "agent_response",
  ...overrides,
});

describe("agyStepToRuntimeEvents", () => {
  it("maps a text delta to content.delta with a stable item id", () => {
    const events = agyStepToRuntimeEvents(context, step({ textDelta: "hello" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("content.delta");
    expect(events[0]?.itemId).toBe("agy-step-1");
    expect(events[0]?.raw?.source).toBe("agy.streamjson");
  });

  it("completes the assistant message on a DONE agent_response", () => {
    const events = agyStepToRuntimeEvents(context, step({ state: "DONE", textDelta: "!" }));
    expect(events.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
  });

  it("drops user_input and system_message steps", () => {
    expect(agyStepToRuntimeEvents(context, step({ stepType: "user_input" }))).toEqual([]);
    expect(agyStepToRuntimeEvents(context, step({ stepType: "system_message" }))).toEqual([]);
  });

  it("maps a running command tool to an in-progress command_execution item", () => {
    const events = agyStepToRuntimeEvents(
      context,
      step({
        stepIndex: 2,
        stepType: "tool",
        toolName: "run_command",
        toolParameters: { CommandLine: "ls" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("item.updated");
    expect(events[0]?.payload).toMatchObject({
      itemType: "command_execution",
      status: "inProgress",
      title: "run_command",
    });
  });

  it("maps an edit tool to file_change and a failure to status failed", () => {
    const done = agyStepToRuntimeEvents(
      context,
      step({ stepIndex: 3, state: "DONE", stepType: "tool", toolName: "write_to_file" }),
    );
    expect(done[0]?.type).toBe("item.completed");
    expect(done[0]?.payload).toMatchObject({ itemType: "file_change", status: "completed" });

    const failed = agyStepToRuntimeEvents(
      context,
      step({
        stepIndex: 4,
        state: "ERROR",
        stepType: "tool",
        toolName: "find_by_name",
        errorMessage: "no such directory",
      }),
    );
    expect(failed[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "failed",
      detail: "no such directory",
    });
  });
});

describe("agyResultToRuntimeEvents", () => {
  const result = (overrides: Partial<AgyResult>): AgyResult => ({
    conversationId: "conv_1",
    status: "SUCCESS",
    response: "done",
    numTurns: 1,
    ...overrides,
  });

  it("completes the turn and carries usage", () => {
    const events = agyResultToRuntimeEvents(
      context,
      result({
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          thinkingTokens: 3,
          cacheReadTokens: 2,
          totalTokens: 15,
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.completed");
    expect(events[0]?.payload).toMatchObject({
      state: "completed",
      usage: {
        usedTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        reasoningOutputTokens: 3,
      },
    });
  });

  it("emits a runtime error alongside a failed turn", () => {
    const events = agyResultToRuntimeEvents(
      context,
      result({ status: "ERROR", response: "", errorMessage: "boom" }),
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "runtime.error"]);
    expect(events[0]?.payload).toMatchObject({ state: "failed", errorMessage: "boom" });
  });

  it("falls back to default message when error result has empty errorMessage", () => {
    const events = agyResultToRuntimeEvents(
      context,
      result({ status: "ERROR", response: "", errorMessage: "" }),
    );
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "runtime.error"]);
    expect(events[1]?.payload).toMatchObject({
      message: "Antigravity CLI reported an error.",
    });
  });
});
