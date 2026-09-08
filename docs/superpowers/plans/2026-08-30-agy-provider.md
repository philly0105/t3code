# Agy (Gemini Antigravity) Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agy` (the Gemini Antigravity CLI) as a sixth built-in provider driver in T3 Code, using the user's existing Antigravity subscription via the CLI's own keyring auth.

**Architecture:** One long-lived `agy` child process per thread, driven over its NDJSON stream-json protocol (`--input-format stream-json --output-format stream-json`). A pure codec decodes stdout lines into a tagged union; a pure mapper turns those into `ProviderRuntimeEvent`s; a thin Effect runtime owns the process and stdin writer; the adapter implements `ProviderAdapterShape`. No ACP, no vendor SDK — the protocol is small enough to parse directly.

**Tech Stack:** TypeScript, Effect (effect-smol), Effect/Schema contracts, Vitest via `@effect/vitest`, `ChildProcessSpawner` from `effect/unstable/process`.

## Global Constraints

These apply to every task. Copied from `AGENTS.md` and from live probing of `agy` v1.1.22.

- **Effect style:** read `.repos/effect-smol/LLMS.md` before writing Effect code. Never edit or import from `.repos/`.
- **Inferred types over annotations. `any` is banned.**
- **Complexity belongs at the adapter boundary.** Orchestration stays pure, UI stays dumb.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`. Use `vp test run <files>` for the files you touched.
- **Driver kind is the string `agy`** everywhere (`ProviderDriverKind.make("agy")`).
- **Display name is `Antigravity`**, badge label `Early Access`.
- **Default enabled = `false`** — matches Cursor, Grok, and OpenCode. Users opt in from Settings.
- **CLI invocation must use `--print=""`**, not `-p`. `agy`'s flag parser treats the next bare argument after `-p`/`--print` as the prompt, so `-p --input-format stream-json` is parsed as the prompt string `--input-format`. Attaching with `=` is the only safe form.
- **Always pass `--dangerously-skip-permissions`.** Print mode reports `permission_mode: always-proceed` regardless; passing it explicitly makes the behavior honest rather than incidental.
- **Approvals are not supported by the CLI.** `agy` recognizes a `control_request` stream input event but answers `"stream input message event \"control_request\" is not supported yet"`. There is no way to answer a permission prompt over stdin. This adapter therefore never emits `request.opened` and never resolves one.
- **Interrupt is process-kill only**, for the same reason. Recovery is a fresh spawn with `--conversation <id>`; resume across processes is verified working.

### Verified protocol reference

Recorded against `agy` 1.1.22 on Windows. Treat this as the spec for Tasks 2 and 3.

Invocation:

```
agy --print="" --input-format stream-json --output-format stream-json \
    --dangerously-skip-permissions --model <slug> --mode <accept-edits|plan> \
    [--conversation <uuid>] [--print-timeout 30m]
```

Input, one JSON object per line on stdin, one turn per line:

```json
{
  "event": "user",
  "message": { "role": "user", "content": [{ "type": "text", "text": "say exactly: one" }] }
}
```

Output, one JSON object per line on stdout:

```json
{"event":"init","conversation_id":"6fe86a3d-...","init":{"cwd":"C:\\...","tools":["view_file","run_command"],"permission_mode":"always-proceed"}}
{"event":"step_update","step_update":{"conversation_id":"6fe86a3d-...","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"one"}}
{"event":"step_update","step_update":{"conversation_id":"6fe86a3d-...","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":1.19,"usage":{"input_tokens":16290,"output_tokens":106,"thinking_tokens":105,"cache_read_tokens":0,"total_tokens":16396}}}
{"event":"step_update","step_update":{"conversation_id":"6fe86a3d-...","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"C:\\probe.txt"}}}}
{"event":"step_update","step_update":{"conversation_id":"6fe86a3d-...","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.04,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"C:\\probe.txt"},"output":"2 lines, 12 bytes"}}}
{"event":"step_update","step_update":{"conversation_id":"6fe86a3d-...","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"find_by_name","tool_info":{"name":"find_by_name","parameters":{},"error":{"type":"TOOL_ERROR","message":"search directory does not exist"}}}}
{"event":"result","result":{"conversation_id":"6fe86a3d-...","status":"SUCCESS","response":"one\n","duration_seconds":3.45,"num_turns":1,"usage":{"input_tokens":16290,"output_tokens":106,"thinking_tokens":105,"cache_read_tokens":0,"total_tokens":16396}}}
```

Facts that constrain the design:

- `step_type` observed: `user_input`, `agent_response`, `tool`, `system_message`.
- `state` observed: `ACTIVE`, `DONE`, `ERROR`.
- `text_delta` is incremental and appears on both `ACTIVE` and `DONE` agent_response steps. Concatenating every `text_delta` for a given `step_index` reconstructs the message.
- `usage` appears only on `DONE`/`ERROR` steps and on `result`.
- Tool `output` is a **summary string**, not raw content (`"2 lines, 12 bytes"`). `run_command` is the exception and returns real stdout. Do not expect diffs from tool output; T3's git checkpoints supply those.
- No reasoning/thinking text is emitted, only `thinking_tokens` counts.
- One `result` per input line. The process stays alive for more input and exits on stdin EOF.
- `agy --version` prints a bare version string (`1.1.22`) and exits 0. There is no `agy version` subcommand.
- `agy models` prints tab-separated `slug<TAB>Display Name` lines after a `Fetching available models...` header line on stdout.

---

### Task 1: Contracts — driver kind, settings, raw event source

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/model.ts:129-155`
- Modify: `packages/contracts/src/providerRuntime.ts:21-32`
- Test: `packages/contracts/src/settings.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `AgySettings` (Effect Schema, type `AgySettings` with fields `enabled: boolean`, `binaryPath: string`, `customModels: ReadonlyArray<string>`); the driver-kind string literal `"agy"`; the raw event source literal `"agy.streamjson"`.

Note: `docs/internals/providers.md:40` claims a new driver needs no contract change. That is wrong for the raw event source — `RuntimeEventRawSource` is a closed union and every provider has its own literal. Fix that doc line in Task 9.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/settings.test.ts`:

```typescript
it("defaults agy to disabled with an agy binary path", () => {
  const decoded = Schema.decodeSync(ServerSettings)({});
  expect(decoded.providers.agy.enabled).toBe(false);
  expect(decoded.providers.agy.binaryPath).toBe("agy");
  expect(decoded.providers.agy.customModels).toEqual([]);
});

it("treats agy as opt-in per driver", () => {
  const agy = ProviderDriverKind.make("agy");
  expect(defaultEnabledForDriver(agy)).toBe(false);
  expect(resolveProviderInstanceEnabled({ driver: agy, config: {} })).toBe(false);
  expect(resolveProviderInstanceEnabled({ driver: agy, enabled: true, config: {} })).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run packages/contracts/src/settings.test.ts`
Expected: FAIL — `providers.agy` is undefined.

- [ ] **Step 3: Add `AgySettings` to `packages/contracts/src/settings.ts`**

Insert directly after the `GrokSettings` block (which ends at the `export type GrokSettings` line):

```typescript
export const AgySettings = makeProviderSettingsSchema(
  {
    // Off by default (like Cursor, Grok, and OpenCode): the binding is new
    // and the CLI cannot express approvals, so users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agy").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Antigravity CLI binary.",
        providerSettingsForm: { placeholder: "agy", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type AgySettings = typeof AgySettings.Type;
```

- [ ] **Step 4: Register it in the settings struct and patch schema**

In the `providers:` struct (around `packages/contracts/src/settings.ts:659`), add after the `grok` line:

```typescript
    agy: AgySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
```

Next to `GrokSettingsPatch` (around line 798), add:

```typescript
const AgySettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});
```

And in `ServerSettingsPatch`'s `providers` struct, after the `grok` line:

```typescript
      agy: Schema.optionalKey(AgySettingsPatch),
```

- [ ] **Step 5: Add the driver kind and default model**

In `packages/contracts/src/model.ts`, next to the other driver-kind constants (around line 133):

```typescript
const AGY_DRIVER_KIND = ProviderDriverKind.make("agy");
```

In `DEFAULT_MODEL_BY_PROVIDER`, after the `grok` entry:

```typescript
  [AGY_DRIVER_KIND]: "gemini-3.7-flash-high",
```

Do not add an entry to `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER` or `MODEL_SLUG_ALIASES_BY_PROVIDER`. Agy exposes no cheap dedicated summarization model, and its slugs already bake effort in, so aliases would only add ambiguity.

- [ ] **Step 6: Add the raw event source literal**

In `packages/contracts/src/providerRuntime.ts`, inside the `RuntimeEventRawSource` union (line 21), add before the `acp.jsonrpc` literal:

```typescript
  Schema.Literal("agy.streamjson"),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `vp test run packages/contracts/src/settings.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/model.ts packages/contracts/src/providerRuntime.ts packages/contracts/src/settings.test.ts
git commit -m "feat(contracts): add agy provider settings and driver kind"
```

---

### Task 2: Stream-json codec

**Files:**

- Create: `apps/server/src/provider/agy/AgyStreamJson.ts`
- Test: `apps/server/src/provider/agy/AgyStreamJson.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `encodeAgyUserMessage(text: string): string` — one NDJSON line **including** its trailing `\n`.
  - `type AgyOutputLine` — tagged union: `{ _tag: "Init"; conversationId: string; cwd: string; tools: ReadonlyArray<string> }` | `{ _tag: "Step"; step: AgyStep }` | `{ _tag: "Result"; result: AgyResult }` | `{ _tag: "Unknown"; raw: unknown }`.
  - `interface AgyStep { conversationId: string; stepIndex: number; state: "ACTIVE" | "DONE" | "ERROR"; stepType: "user_input" | "agent_response" | "tool" | "system_message" | "other"; textDelta?: string; toolName?: string; toolParameters?: Record<string, unknown>; toolOutput?: string; errorMessage?: string; usage?: AgyUsage }`
  - `interface AgyResult { conversationId: string; status: "SUCCESS" | "ERROR"; response: string; errorMessage?: string; numTurns: number; usage?: AgyUsage }`
  - `interface AgyUsage { inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadTokens: number; totalTokens: number }`
  - `decodeAgyOutputLine(line: string): AgyOutputLine` — never throws; malformed input becomes `Unknown`.

This file is pure and has no Effect dependency. That is deliberate: it is the piece most likely to need adjustment as `agy` evolves, and pure functions are the cheapest thing to test.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/agy/AgyStreamJson.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { decodeAgyOutputLine, encodeAgyUserMessage } from "./AgyStreamJson.ts";

describe("encodeAgyUserMessage", () => {
  it("emits one newline-terminated content-block message", () => {
    const line = encodeAgyUserMessage("say exactly: one");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: "say exactly: one" }] },
    });
  });
});

describe("decodeAgyOutputLine", () => {
  it("decodes init", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"init","conversation_id":"abc","init":{"cwd":"/w","tools":["view_file"],"permission_mode":"always-proceed"}}',
    );
    expect(decoded).toEqual({
      _tag: "Init",
      conversationId: "abc",
      cwd: "/w",
      tools: ["view_file"],
    });
  });

  it("decodes a streaming agent_response step", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"step_update","step_update":{"conversation_id":"abc","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"one"}}',
    );
    expect(decoded._tag).toBe("Step");
    if (decoded._tag !== "Step") throw new Error("unreachable");
    expect(decoded.step.stepIndex).toBe(1);
    expect(decoded.step.state).toBe("ACTIVE");
    expect(decoded.step.stepType).toBe("agent_response");
    expect(decoded.step.textDelta).toBe("one");
  });

  it("decodes a tool step with parameters and summarized output", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/w/p.txt"},"output":"2 lines, 12 bytes"}}}',
    );
    if (decoded._tag !== "Step") throw new Error("unreachable");
    expect(decoded.step.toolName).toBe("view_file");
    expect(decoded.step.toolParameters).toEqual({ AbsolutePath: "/w/p.txt" });
    expect(decoded.step.toolOutput).toBe("2 lines, 12 bytes");
  });

  it("decodes a failed tool step's error message", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"step_update","step_update":{"conversation_id":"abc","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"find_by_name","tool_info":{"name":"find_by_name","parameters":{},"error":{"type":"TOOL_ERROR","message":"no such directory"}}}}',
    );
    if (decoded._tag !== "Step") throw new Error("unreachable");
    expect(decoded.step.state).toBe("ERROR");
    expect(decoded.step.errorMessage).toBe("no such directory");
  });

  it("decodes result usage", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"one\\n","duration_seconds":3.4,"num_turns":1,"usage":{"input_tokens":16290,"output_tokens":106,"thinking_tokens":105,"cache_read_tokens":0,"total_tokens":16396}}}',
    );
    if (decoded._tag !== "Result") throw new Error("unreachable");
    expect(decoded.result.status).toBe("SUCCESS");
    expect(decoded.result.response).toBe("one\n");
    expect(decoded.result.usage?.inputTokens).toBe(16290);
    expect(decoded.result.usage?.thinkingTokens).toBe(105);
  });

  it("decodes an error result", () => {
    const decoded = decodeAgyOutputLine(
      '{"event":"result","result":{"conversation_id":"abc","status":"ERROR","response":"","error":"stream input message event \\"control_request\\" is not supported yet","num_turns":0}}',
    );
    if (decoded._tag !== "Result") throw new Error("unreachable");
    expect(decoded.result.status).toBe("ERROR");
    expect(decoded.result.errorMessage).toContain("not supported yet");
  });

  it("returns Unknown for malformed or unrecognized lines without throwing", () => {
    expect(decodeAgyOutputLine("not json")._tag).toBe("Unknown");
    expect(decodeAgyOutputLine('{"event":"future_thing"}')._tag).toBe("Unknown");
    expect(decodeAgyOutputLine("")._tag).toBe("Unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/agy/AgyStreamJson.test.ts`
Expected: FAIL — cannot resolve `./AgyStreamJson.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/provider/agy/AgyStreamJson.ts`:

```typescript
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
      const init = asRecord(record["init"]) ?? {};
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vp test run apps/server/src/provider/agy/AgyStreamJson.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/agy/AgyStreamJson.ts apps/server/src/provider/agy/AgyStreamJson.test.ts
git commit -m "feat(server): add agy stream-json codec"
```

---

### Task 3: Runtime event mapping

**Files:**

- Create: `apps/server/src/provider/agy/AgyRuntimeEvents.ts`
- Test: `apps/server/src/provider/agy/AgyRuntimeEvents.test.ts`

**Interfaces:**

- Consumes: `AgyStep`, `AgyResult`, `AgyUsage` from Task 2. The `"agy.streamjson"` raw source from Task 1.
- Produces:
  - `interface AgyEventStamp { readonly eventId: EventId; readonly createdAt: string }`
  - `interface AgyEventContext { readonly stamp: AgyEventStamp; readonly threadId: ThreadId; readonly turnId: TurnId | undefined; readonly providerInstanceId: ProviderInstanceId | undefined }`
  - `agyStepToRuntimeEvents(context: AgyEventContext, step: AgyStep): ReadonlyArray<ProviderRuntimeEvent>`
  - `agyResultToRuntimeEvents(context: AgyEventContext, result: AgyResult): ReadonlyArray<ProviderRuntimeEvent>`

Each decoded line can produce zero, one, or two runtime events, hence the array return.

Mapping rules, decided here so the implementer does not have to invent them:

| Agy input                               | Runtime event                                                               |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `agent_response` with `textDelta`       | `content.delta`, `streamKind: "assistant_text"`, `itemId: agy-step-<index>` |
| `agent_response`, state `DONE`          | `item.completed`, `itemType: "assistant_message"`                           |
| `tool`, state `ACTIVE`                  | `item.updated`, status `inProgress`                                         |
| `tool`, state `DONE`                    | `item.completed`, status `completed`                                        |
| `tool`, state `ERROR`                   | `item.completed`, status `failed`                                           |
| `user_input`, `system_message`, `other` | none (dropped)                                                              |
| `result`, status `SUCCESS`              | `turn.completed`, state `completed`                                         |
| `result`, status `ERROR`                | `turn.completed`, state `failed`, plus `runtime.error`                      |

Tool-name to `ToolLifecycleItemType`: `run_command` → `command_execution`; `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` → `file_change`; `search_web`, `read_url_content` → `web_search`; everything else → `dynamic_tool_call`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/agy/AgyRuntimeEvents.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/agy/AgyRuntimeEvents.test.ts`
Expected: FAIL — cannot resolve `./AgyRuntimeEvents.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/provider/agy/AgyRuntimeEvents.ts`:

```typescript
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
    events.push({
      type: "runtime.error",
      ...base(context),
      payload: { message: result.errorMessage ?? "Antigravity CLI reported an error." },
    });
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vp test run apps/server/src/provider/agy/AgyRuntimeEvents.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/agy/AgyRuntimeEvents.ts apps/server/src/provider/agy/AgyRuntimeEvents.test.ts
git commit -m "feat(server): map agy stream-json steps to runtime events"
```

---

### Task 4: Mock CLI and session runtime

**Files:**

- Create: `apps/server/scripts/agy-mock-cli.ts`
- Create: `apps/server/src/provider/agy/testSupport.ts`
- Create: `apps/server/src/provider/agy/AgySessionRuntime.ts`
- Test: `apps/server/src/provider/agy/AgySessionRuntime.test.ts`

**Interfaces:**

- Consumes: `encodeAgyUserMessage`, `decodeAgyOutputLine`, `AgyOutputLine` (Task 2); `AgySettings` (Task 1).
- Produces:
  - `makeMockAgyBinary(): Promise<string>` in `testSupport.ts` — writes a platform-appropriate wrapper and returns its path.
  - `buildAgyLaunchArgs(input: { model?: string; interactionMode?: "default" | "plan"; conversationId?: string }): ReadonlyArray<string>`
  - `interface AgyProcess { readonly sendTurn: (text: string) => Effect.Effect<void, AgyProcessError>; readonly lines: Stream.Stream<AgyOutputLine>; readonly kill: () => Effect.Effect<void>; readonly conversationId: Effect.Effect<string | undefined> }`
  - `makeAgyProcess(input: { settings: AgySettings; cwd: string; environment: NodeJS.ProcessEnv; model?: string; interactionMode?: "default" | "plan"; conversationId?: string }): Effect.Effect<AgyProcess, AgyProcessError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>`
  - `class AgyProcessError extends Data.TaggedError("AgyProcessError")<{ detail: string; cause?: unknown }>`

The runtime owns exactly one child process and exposes decoded lines as a `Stream`. It does not know about threads, turns, or runtime events — Task 5 wires those.

Grok's mock uses a `#!/bin/sh` wrapper, which does not run on Windows. This one emits a `.cmd` wrapper on `win32` so the suite passes on every maintainer's machine.

- [ ] **Step 1: Write the mock CLI**

Create `apps/server/scripts/agy-mock-cli.ts`:

```typescript
/**
 * Mock `agy` CLI for adapter tests. Speaks the stream-json protocol:
 * reads one NDJSON user message per line on stdin and replies with an
 * init/step/result sequence. Behavior is scripted through env vars so
 * tests stay declarative.
 *
 * AGY_MOCK_CONVERSATION_ID  conversation id to report (default "mock-conv")
 * AGY_MOCK_TOOL_NAME        if set, emit an ACTIVE+DONE tool step per turn
 * AGY_MOCK_FAIL             if "1", report status ERROR on the result
 * AGY_MOCK_HANG             if "1", never answer (for interrupt tests)
 */
import * as readline from "node:readline";

const conversationId = process.env["AGY_MOCK_CONVERSATION_ID"] ?? "mock-conv";
const toolName = process.env["AGY_MOCK_TOOL_NAME"];
const shouldFail = process.env["AGY_MOCK_FAIL"] === "1";
const shouldHang = process.env["AGY_MOCK_HANG"] === "1";

const emit = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

emit({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: process.cwd(),
    tools: ["view_file", "run_command"],
    permission_mode: "always-proceed",
  },
});

let stepIndex = 0;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim().length === 0 || shouldHang) return;

  let text = "";
  try {
    const parsed = JSON.parse(line);
    text = parsed?.message?.content?.[0]?.text ?? "";
  } catch {
    text = "";
  }

  const step = (fields: Record<string, unknown>) => {
    emit({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });
  };

  if (toolName) {
    stepIndex += 1;
    const toolStep = stepIndex;
    step({
      step_index: toolStep,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: toolName,
      tool_info: { name: toolName, parameters: { Echo: text } },
    });
    step({
      step_index: toolStep,
      state: "DONE",
      step_type: "tool",
      tool_name: toolName,
      tool_info: { name: toolName, parameters: { Echo: text }, output: "ok" },
    });
  }

  stepIndex += 1;
  const responseStep = stepIndex;
  step({
    step_index: responseStep,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: "echo:",
  });
  step({
    step_index: responseStep,
    state: "DONE",
    step_type: "agent_response",
    text_delta: text,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 3,
    },
  });

  emit({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: shouldFail ? "ERROR" : "SUCCESS",
      response: shouldFail ? "" : `echo:${text}`,
      ...(shouldFail ? { error: "mock failure" } : {}),
      num_turns: 1,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 3,
      },
    },
  });
});
```

- [ ] **Step 2: Write the shared test helper**

Create `apps/server/src/provider/agy/testSupport.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test-only helper: writes a wrapper script that runs the mock agy CLI and
 * can be handed to the adapter as a `binaryPath`. Platform-aware, because
 * the shell wrappers used by the ACP provider tests are POSIX-only.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/agy-mock-cli.ts");

export async function makeMockAgyBinary(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-mock-"));
  if (process.platform === "win32") {
    const wrapperPath = NodePath.join(dir, "fake-agy.cmd");
    await NodeFSP.writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${mockPath}" %*\r\n`,
      "utf8",
    );
    return wrapperPath;
  }
  const wrapperPath = NodePath.join(dir, "fake-agy.sh");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/server/src/provider/agy/AgySessionRuntime.test.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

it("passes --conversation when resuming", () => {
  const args = buildAgyLaunchArgs({ conversationId: "conv-9" });
  const index = args.indexOf("--conversation");
  assert.isAtLeast(index, 0);
  assert.strictEqual(args[index + 1], "conv-9");
});

it.effect("streams decoded lines for one turn and reports the conversation id", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockAgyBinary());
    const agyProcess = yield* makeAgyProcess({
      settings: decodeAgySettings({ enabled: true, binaryPath }),
      cwd: NodeOS.tmpdir(),
      environment: { ...process.env, AGY_MOCK_CONVERSATION_ID: "conv-test" },
    });

    const collected = yield* Effect.fork(
      Stream.runCollect(Stream.takeUntil(agyProcess.lines, (line) => line._tag === "Result")),
    );
    yield* agyProcess.sendTurn("hi");
    const lines = Array.from(yield* Effect.fromFiber(collected));

    const tags = lines.map((line) => line._tag);
    assert.strictEqual(tags[0], "Init");
    assert.strictEqual(tags.at(-1), "Result");
    assert.strictEqual(yield* agyProcess.conversationId, "conv-test");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
```

- [ ] **Step 4: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/agy/AgySessionRuntime.test.ts`
Expected: FAIL — cannot resolve `./AgySessionRuntime.ts`.

- [ ] **Step 5: Write the implementation**

Create `apps/server/src/provider/agy/AgySessionRuntime.ts`. Read `.repos/effect-smol/LLMS.md` for `ChildProcessSpawner` and `Stream` idiom before writing; follow the spawn shape already used in `apps/server/src/provider/Layers/GrokProvider.ts` (`resolveSpawnCommand` + `ChildProcess.make`).

```typescript
/**
 * Owns one `agy` child process and exposes its stream-json output as
 * decoded lines. Thread, turn, and event concerns stay in AgyAdapter.
 *
 * @module provider/agy/AgySessionRuntime
 */
import type { AgySettings } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  readonly lines: Stream.Stream<AgyOutputLine>;
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
  const command = input.settings.binaryPath || "agy";
  const args = buildAgyLaunchArgs(input);

  const spawnCommand = yield* resolveSpawnCommand(command, args, {
    env: input.environment,
  }).pipe(
    Effect.mapError((cause) => new AgyProcessError({ detail: `Cannot resolve ${command}`, cause })),
  );

  const child = yield* ChildProcessSpawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: input.environment,
      cwd: input.cwd,
      shell: spawnCommand.shell,
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new AgyProcessError({ detail: `Failed to spawn ${command}`, cause }),
    ),
  );

  const conversationRef = yield* Ref.make<string | undefined>(input.conversationId);

  const lines = child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.map(decodeAgyOutputLine),
    Stream.tap((line) =>
      line._tag === "Init" ? Ref.set(conversationRef, line.conversationId) : Effect.void,
    ),
  );

  return {
    lines,
    conversationId: Ref.get(conversationRef),
    sendTurn: (text) =>
      child.stdin
        .write(new TextEncoder().encode(encodeAgyUserMessage(text)))
        .pipe(
          Effect.mapError(
            (cause) => new AgyProcessError({ detail: "Failed to write turn to agy stdin", cause }),
          ),
        ),
    kill: () => child.kill().pipe(Effect.ignore),
  };
});
```

If the exact `ChildProcessSpawner` / `Stream.decodeText` names differ in this effect-smol version, follow the shapes already used in `apps/server/src/provider/acp/AcpSessionRuntime.ts` rather than inventing new ones.

- [ ] **Step 6: Run tests to verify they pass**

Run: `vp test run apps/server/src/provider/agy/AgySessionRuntime.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/server/scripts/agy-mock-cli.ts apps/server/src/provider/agy/testSupport.ts apps/server/src/provider/agy/AgySessionRuntime.ts apps/server/src/provider/agy/AgySessionRuntime.test.ts
git commit -m "feat(server): add agy process runtime and mock CLI"
```

---

### Task 5: Adapter

**Files:**

- Create: `apps/server/src/provider/Services/AgyAdapter.ts`
- Create: `apps/server/src/provider/Layers/AgyAdapter.ts`
- Test: `apps/server/src/provider/Layers/AgyAdapter.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–4, including `makeMockAgyBinary` from `../agy/testSupport.ts`.
- Produces:
  - `type AgyAdapterShape = ProviderAdapterShape<ProviderAdapterError>` in `Services/AgyAdapter.ts` (mirror the 16-line `Services/GrokAdapter.ts`).
  - `makeAgyAdapter(settings: AgySettings, options: { environment: NodeJS.ProcessEnv; instanceId: ProviderInstanceId; nativeEventLogger?: NativeEventLogger }): Effect.Effect<AgyAdapterShape, never, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope>`

Behavior contract, decided here:

- `startSession` spawns nothing. It records the thread's cwd, model, and runtime mode, and returns a `ProviderSession` with status `ready`. The process starts lazily on the first `sendTurn`, so an idle thread costs nothing. `resumeCursor` carries `{ conversationId }` when resuming.
- `sendTurn` spawns the process if absent (passing `--conversation` when a conversation id is known), emits `turn.started`, writes one line, and pumps decoded lines through the Task 3 mappers into `streamEvents` until the `Result` line.
- `interruptTurn` kills the process and emits `turn.aborted` with reason `"interrupted"`. The conversation id is retained so the next turn resumes. This is the only interrupt available: `agy` answers `control_request` with "not supported yet".
- `respondToRequest` and `respondToUserInput` always fail with `ProviderAdapterRequestError`. The adapter never emits `request.opened`, so a well-behaved caller never reaches them; failing loudly beats silently accepting.
- `capabilities.sessionModelSwitch` is `"unsupported"` — the model is a launch flag.
- `readThread` returns `{ threadId, turns: [] }` and `rollbackThread` fails with `ProviderAdapterValidationError`. Agy exposes no thread-history read API; T3's own event store and git checkpoints are the source of truth. Do not fake it.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/Layers/AgyAdapter.test.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

    const collected = yield* Effect.fork(
      Stream.runCollect(
        Stream.takeUntil(adapter.streamEvents, (event) => event.type === "turn.completed"),
      ),
    );

    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hi" });

    const events = Array.from(yield* Effect.fromFiber(collected)) as Array<ProviderRuntimeEvent>;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/Layers/AgyAdapter.test.ts`
Expected: FAIL — cannot resolve `./AgyAdapter.ts`.

- [ ] **Step 3: Write the service alias**

Create `apps/server/src/provider/Services/AgyAdapter.ts`, mirroring `Services/GrokAdapter.ts` exactly (read that file first — it is 16 lines) but substituting `Agy` for `Grok`.

- [ ] **Step 4: Write the adapter**

Create `apps/server/src/provider/Layers/AgyAdapter.ts`. Structure it as:

1. A `SessionState` record per thread: `{ session: ProviderSession; cwd: string; model: string | undefined; interactionMode: "default" | "plan"; conversationId: string | undefined; process: AgyProcess | undefined; activeTurn: { turnId: TurnId; fiber: Fiber.Fiber<void> } | undefined }`, held in a `SynchronizedRef<Map<ThreadId, SessionState>>`.
2. A `PubSub<ProviderRuntimeEvent>` whose subscription is `streamEvents`.
3. A `stamp` helper producing `{ eventId, createdAt }` from `Crypto` and `DateTime`. Copy the equivalent helper out of `GrokAdapter.ts` rather than inventing an id scheme.
4. `sendTurn` forks a fiber that consumes `agyProcess.lines`, feeds each `Step` to `agyStepToRuntimeEvents` and each `Result` to `agyResultToRuntimeEvents`, publishes every produced event to the PubSub, and finishes on the `Result` line.

Use `GrokAdapter.ts` as the structural reference for Effect idiom (`SynchronizedRef`, `PubSub`, scoped fiber management, and error mapping to `ProviderAdapterProcessError`, `ProviderAdapterRequestError`, `ProviderAdapterSessionNotFoundError`, and `ProviderAdapterValidationError` from `../Errors.ts`). Do not copy its ACP machinery — none of it applies.

- [ ] **Step 5: Run tests to verify they pass**

Run: `vp test run apps/server/src/provider/Layers/AgyAdapter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/Services/AgyAdapter.ts apps/server/src/provider/Layers/AgyAdapter.ts apps/server/src/provider/Layers/AgyAdapter.test.ts
git commit -m "feat(server): add agy provider adapter"
```

---

### Task 6: Provider snapshot and model discovery

**Files:**

- Create: `apps/server/src/provider/Layers/AgyProvider.ts`
- Test: `apps/server/src/provider/Layers/AgyProvider.test.ts`

**Interfaces:**

- Consumes: `AgySettings` (Task 1).
- Produces:
  - `parseAgyModelsOutput(stdout: string): ReadonlyArray<ServerProviderModel>`
  - `buildInitialAgyProviderSnapshot(settings: AgySettings): Effect.Effect<ServerProviderDraft>`
  - `checkAgyProviderStatus(settings: AgySettings, environment?: NodeJS.ProcessEnv): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto>`
  - `enrichAgySnapshot(input: { snapshot; maintenanceCapabilities; enableProviderUpdateChecks; publishSnapshot; httpClient })`

Presentation constant:

```typescript
const AGY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;
```

`showInteractionModeToggle` is `true` because `--mode plan` is real. `requiresNewThreadForModelChange` is `true` because the model is a launch flag.

The version probe is `agy --version`, which prints a bare `1.1.22` and exits 0. There is no `agy version` subcommand — it errors.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/Layers/AgyProvider.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { parseAgyModelsOutput } from "./AgyProvider.ts";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/Layers/AgyProvider.test.ts`
Expected: FAIL — cannot resolve `./AgyProvider.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/provider/Layers/AgyProvider.ts`, modeled on `GrokProvider.ts`. Replace `discoverGrokModelsViaAcp` with an `agy models` shell-out, and the `--version` parsing with a bare-version reader. The parser:

```typescript
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

/**
 * `agy models` prints a "Fetching available models..." header, then one
 * `slug<TAB>Display Name` line per model. The list is account-scoped and
 * fetched live, so it is never hardcoded.
 */
export function parseAgyModelsOutput(stdout: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Fetching"))
    .flatMap((line): ReadonlyArray<ServerProviderModel> => {
      const [rawSlug, rawName] = line.split("\t");
      const slug = rawSlug?.trim();
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: rawName?.trim() || slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        },
      ];
    });
}
```

For `checkAgyProviderStatus`, follow `checkGrokProviderStatus` step for step: return the disabled draft when `!settings.enabled`; run `agy --version` through `spawnAndCollect` with a 4s timeout; on `isCommandMissingCause` report `installed: false` with a message pointing at the Antigravity install; on success run `agy models` with a 15s timeout and merge `parseAgyModelsOutput` results with `providerModelsFromSettings(…, settings.customModels, EMPTY_CAPABILITIES)`. Take the version string as the trimmed first non-empty stdout line — `parseGenericCliVersion` expects a `name version` shape and will not match a bare `1.1.22`.

`enrichAgySnapshot` mirrors `enrichGrokSnapshot`, calling `enrichProviderSnapshotWithVersionAdvisory`. Maintenance is manual-only (Task 7 wires `makeManualOnlyProviderMaintenanceCapabilities` with `packageName: null`) because `agy` self-updates through its own `agy update` subcommand and has no npm package T3 can check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `vp test run apps/server/src/provider/Layers/AgyProvider.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/AgyProvider.ts apps/server/src/provider/Layers/AgyProvider.test.ts
git commit -m "feat(server): add agy provider snapshot and model discovery"
```

---

### Task 7: Driver and registration

**Files:**

- Create: `apps/server/src/provider/Drivers/AgyDriver.ts`
- Modify: `apps/server/src/provider/builtInDrivers.ts`
- Test: `apps/server/src/provider/Layers/ProviderRegistry.test.ts`

**Interfaces:**

- Consumes: `makeAgyAdapter` (Task 5); `buildInitialAgyProviderSnapshot`, `checkAgyProviderStatus`, `enrichAgySnapshot` (Task 6); `AgySettings` (Task 1).
- Produces: `AgyDriver: ProviderDriver<AgySettings, AgyDriverEnv>` and `type AgyDriverEnv`.

`AgyDriver.ts` is a near-transcription of `GrokDriver.ts`. The differences:

- `DRIVER_KIND = ProviderDriverKind.make("agy")`, `metadata.displayName = "Antigravity"`, `supportsMultipleInstances: true`.
- No `textGeneration`. Omit the field entirely — do not wire an equivalent of `makeGrokTextGeneration`. Agy has no cheap dedicated summarization model, and T3 falls back to another provider for title and commit-message generation.
- `AgyDriverEnv` keeps `HttpClient` if `enrichAgySnapshot` follows `enrichGrokSnapshot` (it does).

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/provider/Layers/ProviderRegistry.test.ts`, matching the surrounding test style:

```typescript
it("registers agy among the built-in drivers", () => {
  const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
  expect(kinds).toContain(ProviderDriverKind.make("agy"));
});

it("gives the agy driver an Antigravity display name", () => {
  const agy = BUILT_IN_DRIVERS.find(
    (driver) => driver.driverKind === ProviderDriverKind.make("agy"),
  );
  expect(agy?.metadata.displayName).toBe("Antigravity");
});
```

Add `import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/provider/Layers/ProviderRegistry.test.ts`
Expected: FAIL — `agy` not in `BUILT_IN_DRIVERS`.

- [ ] **Step 3: Write the driver**

Create `apps/server/src/provider/Drivers/AgyDriver.ts` following `GrokDriver.ts` line for line, with the substitutions above.

- [ ] **Step 4: Register it**

In `apps/server/src/provider/builtInDrivers.ts`:

```typescript
import { AgyDriver, type AgyDriverEnv } from "./Drivers/AgyDriver.ts";
```

Add `| AgyDriverEnv` to the `BuiltInDriversEnv` union, and `AgyDriver` to the end of the `BUILT_IN_DRIVERS` array. Update the module doc comment's "five entries" wording if it repeats the count.

- [ ] **Step 5: Run tests and typecheck**

Run: `vp test run apps/server/src/provider/Layers/ProviderRegistry.test.ts`
Expected: PASS

Run: `vp run typecheck --filter @t3tools/server`
Expected: no errors. If `BuiltInDriversEnv` does not satisfy the runtime layer, the missing service is named in the error — provide it in the same layer that already provides `GrokDriverEnv`'s services.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/Drivers/AgyDriver.ts apps/server/src/provider/builtInDrivers.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts
git commit -m "feat(server): register agy as a built-in provider driver"
```

---

### Task 8: Client wiring (web, desktop, mobile)

**Files:**

- Modify: `apps/web/src/components/Icons.tsx`
- Modify: `apps/web/src/components/chat/providerIconUtils.ts:2,10`
- Modify: `apps/web/src/components/settings/providerDriverMeta.ts:57-63`
- Modify: `apps/web/src/session-logic.ts:50-51`
- Modify: `apps/mobile/src/components/ProviderIcon.tsx:26`

Desktop needs no change — it wraps the web app.

**Interfaces:**

- Consumes: `AgySettings` and the `"agy"` driver kind from Task 1.
- Produces: an `AgyIcon` React component exported from `Icons.tsx`, consumed by the web icon map and the settings meta list.

- [ ] **Step 1: Add the icon**

In `apps/web/src/components/Icons.tsx`, add an `AgyIcon` next to `GrokIcon`, following the same component signature and prop handling as its neighbors. Use a simple geometric mark rather than Google or Antigravity brand assets — the repo ships its own marks, and vendoring a trademarked logo is a licensing problem rather than a design one.

- [ ] **Step 2: Wire the web icon map**

In `apps/web/src/components/chat/providerIconUtils.ts`, add `AgyIcon` to the import on line 2 and add to the map:

```typescript
  [ProviderDriverKind.make("agy")]: AgyIcon,
```

- [ ] **Step 3: Wire settings metadata**

In `apps/web/src/components/settings/providerDriverMeta.ts`, add after the `grok` entry:

```typescript
  {
    value: ProviderDriverKind.make("agy"),
    label: "Antigravity",
    icon: AgyIcon,
    badgeLabel: "Early Access",
    settingsSchema: AgySettings,
  },
```

Import `AgySettings` from `@t3tools/contracts` and `AgyIcon` from `../Icons` alongside the existing imports.

- [ ] **Step 4: Wire the session picker**

In `apps/web/src/session-logic.ts`, add after the `grok` entry (line 50-51):

```typescript
  {
    value: ProviderDriverKind.make("agy"),
    label: "Antigravity",
  },
```

Read lines 40-60 first and match the surrounding object's full shape — the entries may carry fields beyond `value` and `label`.

- [ ] **Step 5: Wire the mobile icon**

In `apps/mobile/src/components/ProviderIcon.tsx`, add a branch beside the `grok` one at line 26:

```typescript
  if (props.provider === "agy") {
    return <AgyProviderIcon {...props} />;
  }
```

Define `AgyProviderIcon` in the same file following the shape of the existing per-provider components — mobile does not import from `apps/web`.

- [ ] **Step 6: Verify with targeted typecheck and lint**

```bash
vp run typecheck --filter @t3tools/web
```

```bash
vp run typecheck --filter @t3tools/mobile
```

```bash
vp run lint --filter @t3tools/web
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Icons.tsx apps/web/src/components/chat/providerIconUtils.ts apps/web/src/components/settings/providerDriverMeta.ts apps/web/src/session-logic.ts apps/mobile/src/components/ProviderIcon.tsx
git commit -m "feat(web,mobile): surface the antigravity provider"
```

---

### Task 9: Documentation

**Files:**

- Modify: `docs/internals/providers.md:9-19,40,78-85`
- Modify: `docs/user/install.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the finished feature.
- Produces: no code.

`docs/` splits by audience. User-visible behavior goes in `docs/user/` in shipped-product voice with no repo paths; architecture goes in `docs/internals/`.

- [ ] **Step 1: Update the internals provider table**

In `docs/internals/providers.md`, change "five entries" to "six entries" and add the row:

```markdown
| `agy` | [`Drivers/AgyDriver.ts`][agy] |
```

Add the link definition alongside the others at the bottom:

```markdown
[agy]: ../../apps/server/src/provider/Drivers/AgyDriver.ts
```

- [ ] **Step 2: Correct the stale claim at line 40**

The line "Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No orchestration, contract, or client change is required for the common case." is wrong — `RuntimeEventRawSource` is a closed union. Replace with:

```markdown
Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration change is required. Two contract edits are: a `RuntimeEventRawSource` literal for the
new transport in [`providerRuntime.ts`][contracts-runtime], and a settings schema in
[`settings.ts`][contracts-settings]. Clients need an icon and a label.
```

Add the two link definitions to the bottom block.

- [ ] **Step 3: Document the Antigravity limitations**

Add this subsection to `docs/internals/providers.md` after the driver table:

```markdown
### Antigravity (`agy`) constraints

The Antigravity CLI's stream-json mode is narrower than the other transports, and the adapter is
shaped around three hard limits:

- **No approvals.** Print mode always reports `permission_mode: always-proceed`, and the CLI answers
  a `control_request` stream input with "not supported yet". The adapter never emits
  `request.opened`; `respondToRequest` fails rather than pretending.
- **Interrupt is process termination.** With no control channel, `interruptTurn` kills the child and
  relies on `--conversation <id>` to resume on the next turn.
- **Tool output is summarized.** `view_file` reports `"192 lines, 14801 bytes"` rather than content,
  so per-tool diffs are unavailable. Thread diffs come from T3's git checkpoints instead.
```

- [ ] **Step 4: Update the user-facing install doc**

In `docs/user/install.md`, add Antigravity to the provider list in the same voice as its neighbors: it needs the `agy` CLI on PATH, signed in through `agy` itself, and it stays off until enabled in Settings. Say plainly that Antigravity threads run without approval prompts — that is a behavior difference a user must know before enabling it. Do not mention repo paths or source files.

- [ ] **Step 5: Update the repo overviews**

In `AGENTS.md`, add Antigravity to the provider list in the intro paragraph and to the **Providers** bullet under "Hit every surface". In `README.md`, add it to the supported-providers list.

- [ ] **Step 6: Commit**

```bash
git add docs/internals/providers.md docs/user/install.md AGENTS.md README.md
git commit -m "docs: document the antigravity provider and its constraints"
```

---

## Final verification

- [ ] Run the tests for everything touched:

```bash
vp test run apps/server/src/provider/agy apps/server/src/provider/Layers/AgyAdapter.test.ts apps/server/src/provider/Layers/AgyProvider.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts packages/contracts/src/settings.test.ts
```

- [ ] Typecheck the three changed packages:

```bash
vp run typecheck --filter @t3tools/server --filter @t3tools/web --filter @t3tools/contracts
```

- [ ] Ask the developer before doing a live client pass. With permission: run `vp run dev`, enable Antigravity in Settings, confirm the model list populates from `agy models`, and send one real turn. Do not spin up a browser or dev server without explicit approval.
