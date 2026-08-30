/**
 * Codec for the `agy` CLI's stream-json protocol.
 *
 * Pure and Effect-free on purpose: this is the layer most exposed to
 * upstream CLI churn, so it stays trivially testable. Decoding is total —
 * anything unrecognized becomes `Unknown` rather than failing, so a newer
 * `agy` that adds events cannot crash a running session.
 *
 * @module provider/agy/AgyStreamJson
 */

export interface AgyUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
}

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR";

export type AgyStepType = "user_input" | "agent_response" | "tool" | "system_message" | "other";

export interface AgyStep {
  readonly conversationId: string;
  readonly stepIndex: number;
  readonly state: AgyStepState;
  readonly stepType: AgyStepType;
  readonly textDelta?: string;
  readonly toolName?: string;
  readonly toolParameters?: Record<string, unknown>;
  readonly toolOutput?: string;
  readonly errorMessage?: string;
  readonly usage?: AgyUsage;
}

export interface AgyResult {
  readonly conversationId: string;
  readonly status: "SUCCESS" | "ERROR";
  readonly response: string;
  readonly errorMessage?: string;
  readonly numTurns: number;
  readonly usage?: AgyUsage;
}

export type AgyOutputLine =
  | {
      readonly _tag: "Init";
      readonly conversationId: string;
      readonly cwd: string;
      readonly tools: ReadonlyArray<string>;
    }
  | { readonly _tag: "Step"; readonly step: AgyStep }
  | { readonly _tag: "Result"; readonly result: AgyResult }
  | { readonly _tag: "Unknown"; readonly raw: unknown };

/** Serializes one turn as the NDJSON line `agy` expects on stdin. */
export function encodeAgyUserMessage(text: string): string {
  return `${JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): AgyUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    inputTokens: asNumber(record["input_tokens"]) ?? 0,
    outputTokens: asNumber(record["output_tokens"]) ?? 0,
    thinkingTokens: asNumber(record["thinking_tokens"]) ?? 0,
    cacheReadTokens: asNumber(record["cache_read_tokens"]) ?? 0,
    totalTokens: asNumber(record["total_tokens"]) ?? 0,
  };
}

function parseStepType(value: unknown): AgyStepType {
  switch (value) {
    case "user_input":
    case "agent_response":
    case "tool":
    case "system_message":
      return value;
    default:
      return "other";
  }
}

function parseState(value: unknown): AgyStepState {
  return value === "DONE" || value === "ERROR" ? value : "ACTIVE";
}

function parseStep(raw: Record<string, unknown>): AgyStep {
  const toolInfo = asRecord(raw["tool_info"]);
  const toolError = asRecord(toolInfo?.["error"]);
  const usage = parseUsage(raw["usage"]);
  const textDelta = asString(raw["text_delta"]);
  const toolName = asString(raw["tool_name"]);
  const toolParameters = asRecord(toolInfo?.["parameters"]);
  const toolOutput = asString(toolInfo?.["output"]);
  const errorMessage = asString(toolError?.["message"]) ?? asString(raw["error"]);
  return {
    conversationId: asString(raw["conversation_id"]) ?? "",
    stepIndex: asNumber(raw["step_index"]) ?? -1,
    state: parseState(raw["state"]),
    stepType: parseStepType(raw["step_type"]),
    ...(textDelta === undefined ? {} : { textDelta }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolParameters === undefined ? {} : { toolParameters }),
    ...(toolOutput === undefined ? {} : { toolOutput }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseResult(raw: Record<string, unknown>): AgyResult {
  const usage = parseUsage(raw["usage"]);
  const errorMessage = asString(raw["error"]);
  return {
    conversationId: asString(raw["conversation_id"]) ?? "",
    status: raw["status"] === "ERROR" ? "ERROR" : "SUCCESS",
    response: asString(raw["response"]) ?? "",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    numTurns: asNumber(raw["num_turns"]) ?? 0,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Decodes one stdout line. Total: unrecognized shapes become `Unknown`. */
export function decodeAgyOutputLine(line: string): AgyOutputLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { _tag: "Unknown", raw: line };
  }
  const record = asRecord(parsed);
  if (!record) return { _tag: "Unknown", raw: parsed };

  switch (record["event"]) {
    case "init": {
      const init = asRecord(record["init"]);
      if (!init) return { _tag: "Unknown", raw: parsed };
      const tools = Array.isArray(init["tools"])
        ? init["tools"].filter((tool): tool is string => typeof tool === "string")
        : [];
      return {
        _tag: "Init",
        conversationId: asString(record["conversation_id"]) ?? "",
        cwd: asString(init["cwd"]) ?? "",
        tools,
      };
    }
    case "step_update": {
      const step = asRecord(record["step_update"]);
      return step ? { _tag: "Step", step: parseStep(step) } : { _tag: "Unknown", raw: parsed };
    }
    case "result": {
      const result = asRecord(record["result"]);
      return result
        ? { _tag: "Result", result: parseResult(result) }
        : { _tag: "Unknown", raw: parsed };
    }
    default:
      return { _tag: "Unknown", raw: parsed };
  }
}
