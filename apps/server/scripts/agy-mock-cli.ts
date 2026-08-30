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
