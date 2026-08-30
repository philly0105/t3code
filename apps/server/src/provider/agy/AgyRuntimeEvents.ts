/**
 * Maps decoded `agy` stream-json lines onto canonical `ProviderRuntimeEvent`s.
 *
 * Pure, like the codec beside it: the adapter supplies identity and stamps,
 * this module owns only the shape translation. Unmapped step types are
 * dropped rather than surfaced, so a newer CLI cannot inject junk into the
 * thread timeline.
 *
 * @module provider/agy/AgyRuntimeEvents
 */
import {
  ProviderDriverKind,
  RuntimeItemId,
  type EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { AgyResult, AgyStep, AgyUsage } from "./AgyStreamJson.ts";

const AGY_DRIVER_KIND = ProviderDriverKind.make("agy");
const RAW_SOURCE = "agy.streamjson" as const;

export interface AgyEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface AgyEventContext {
  readonly stamp: AgyEventStamp;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
}

/** Stable per-step item id, so deltas and completion land on one timeline item. */
function itemIdForStep(step: AgyStep): string {
  return `agy-step-${step.stepIndex}`;
}

function itemTypeForTool(toolName: string | undefined): ToolLifecycleItemType {
  switch (toolName) {
    case "run_command":
      return "command_execution";
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return "file_change";
    case "search_web":
    case "read_url_content":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function base(context: AgyEventContext) {
  return {
    ...context.stamp,
    provider: AGY_DRIVER_KIND,
    threadId: context.threadId,
    ...(context.providerInstanceId ? { providerInstanceId: context.providerInstanceId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

function raw(payload: unknown) {
  return { raw: { source: RAW_SOURCE, payload } } as const;
}

function usageSnapshot(usage: AgyUsage) {
  return {
    usedTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    reasoningOutputTokens: usage.thinkingTokens,
  };
}

export function agyStepToRuntimeEvents(
  context: AgyEventContext,
  step: AgyStep,
): ReadonlyArray<ProviderRuntimeEvent> {
  const itemId = RuntimeItemId.make(itemIdForStep(step));

  if (step.stepType === "agent_response") {
    const events: Array<ProviderRuntimeEvent> = [];
    if (step.textDelta !== undefined && step.textDelta.length > 0) {
      events.push({
        type: "content.delta",
        ...base(context),
        itemId,
        payload: { streamKind: "assistant_text", delta: step.textDelta },
        ...raw(step),
      });
    }
    if (step.state === "DONE" || step.state === "ERROR") {
      events.push({
        type: "item.completed",
        ...base(context),
        itemId,
        payload: {
          itemType: "assistant_message",
          status: step.state === "ERROR" ? "failed" : "completed",
        },
      });
    }
    return events;
  }

  if (step.stepType === "tool") {
    const completed = step.state === "DONE" || step.state === "ERROR";
    const detail = step.errorMessage ?? step.toolOutput;
    return [
      {
        type: completed ? "item.completed" : "item.updated",
        ...base(context),
        itemId,
        payload: {
          itemType: itemTypeForTool(step.toolName),
          status: step.state === "ERROR" ? "failed" : completed ? "completed" : "inProgress",
          ...(step.toolName ? { title: step.toolName } : {}),
          ...(detail ? { detail } : {}),
          ...(step.toolParameters ? { data: step.toolParameters } : {}),
        },
        ...raw(step),
      },
    ];
  }

  // user_input, system_message, and anything a newer CLI adds are not
  // timeline-worthy on their own.
  return [];
}

export function agyResultToRuntimeEvents(
  context: AgyEventContext,
  result: AgyResult,
): ReadonlyArray<ProviderRuntimeEvent> {
  const failed = result.status === "ERROR";
  const events: Array<ProviderRuntimeEvent> = [
    {
      type: "turn.completed",
      ...base(context),
      payload: {
        state: failed ? "failed" : "completed",
        ...(result.usage ? { usage: usageSnapshot(result.usage) } : {}),
        ...(failed && result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      },
      ...raw(result),
    },
  ];

  if (failed) {
    const fallback = "Antigravity CLI reported an error.";
    const message = result.errorMessage?.trim() ? result.errorMessage : fallback;
    events.push({
      type: "runtime.error",
      ...base(context),
      payload: { message },
    });
  }

  return events;
}
