import { describe, expect, it } from "@effect/vitest";

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
    expect(decodeAgyOutputLine("[1,2]")._tag).toBe("Unknown");
    expect(decodeAgyOutputLine("null")._tag).toBe("Unknown");
    expect(decodeAgyOutputLine("5")._tag).toBe("Unknown");
    expect(decodeAgyOutputLine("   ")._tag).toBe("Unknown");
    expect(decodeAgyOutputLine('{"event":"step_update"}')._tag).toBe("Unknown");
    expect(decodeAgyOutputLine('{"event":"result"}')._tag).toBe("Unknown");
    expect(decodeAgyOutputLine('{"event":"init"}')._tag).toBe("Unknown");
  });
});
