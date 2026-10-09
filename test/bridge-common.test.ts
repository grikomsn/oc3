import { describe, expect, test } from "bun:test";
import { AnthropicStreamToResponses, anthropicRequestFromResponses, requiresAdaptiveThinking } from "../src/anthropic-bridge";
import { GoogleStreamToResponses, googleRequestFromResponses } from "../src/google-bridge";
import { finishedToolCalls, terminalEvent, zeroUsage } from "../src/bridge-common";
import type { Oc3Model } from "../src/models";

const claude = (rawModelId: string, maxOutputTokens = 8_192): Oc3Model => ({
  id: `acme/${rawModelId}`, rawModelId, providerId: "acme", name: rawModelId,
  contextLength: 200_000, maxOutputTokens, reasoning: true, imageInput: false,
  toolCalling: true, endpoint: "messages", baseUrl: "https://example.test",
});

const gemini: Oc3Model = {
  id: "acme/gemini-3-flash", rawModelId: "gemini-3-flash", providerId: "acme", name: "Gemini 3 Flash",
  contextLength: 128_000, maxOutputTokens: 4_096, reasoning: true, imageInput: false,
  toolCalling: true, endpoint: "google", baseUrl: "https://example.test",
};

const userText = { type: "message", role: "user", content: "hi" };

describe("anthropic thinking", () => {
  test("enables a budget that stays below max_tokens for a plain high-effort turn", () => {
    const request = anthropicRequestFromResponses({ input: [userText], reasoning: { effort: "high" } }, claude("claude-sonnet-4-5"));
    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 7_168 });
    expect((request.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(request.max_tokens as number);
  });

  test("omits thinking when the budget cannot fit under max_tokens", () => {
    const request = anthropicRequestFromResponses({ input: [userText], reasoning: { effort: "high" } }, claude("claude-sonnet-4-5", 1_024));
    expect(request.thinking).toBeUndefined();
  });

  test("uses adaptive thinking for Claude 4.7 and later", () => {
    expect(requiresAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(requiresAdaptiveThinking("claude-haiku-5-5")).toBe(true);
    expect(requiresAdaptiveThinking("claude-sonnet-4-6")).toBe(false);
    expect(requiresAdaptiveThinking("claude-3-5-sonnet-20241022")).toBe(false);
    const request = anthropicRequestFromResponses({ input: [userText], reasoning: { effort: "high" } }, claude("claude-opus-4-7"));
    expect(request.thinking).toEqual({ type: "adaptive" });
  });

  test("forced tool choice falls back to auto under manual thinking", () => {
    const withThinking = anthropicRequestFromResponses({
      input: [userText],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "required",
      reasoning: { effort: "high" },
    }, claude("claude-sonnet-4-5"));
    expect(withThinking.thinking).toBeDefined();
    expect(withThinking.tool_choice).toEqual({ type: "auto" });

    const withoutThinking = anthropicRequestFromResponses({
      input: [userText],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "none",
    }, claude("claude-sonnet-4-5"));
    expect(withoutThinking.tool_choice).toEqual({ type: "none" });
  });

  test("adaptive thinking keeps forced tool choice except on the models that reject it", () => {
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    const adaptive = anthropicRequestFromResponses({ input: [userText], tools, tool_choice: "required", reasoning: { effort: "high" } }, claude("claude-opus-4-8"));
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
    expect(adaptive.tool_choice).toEqual({ type: "any" });

    const rejecting = anthropicRequestFromResponses({ input: [userText], tools, tool_choice: "required", reasoning: { effort: "high" } }, claude("claude-opus-5.5"));
    expect(rejecting.thinking).toEqual({ type: "adaptive" });
    expect(rejecting.tool_choice).toEqual({ type: "auto" });
  });

  test("counts cache reads and writes as input tokens", () => {
    const bridge = new AnthropicStreamToResponses("resp_1");
    bridge.ingest({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } } });
    bridge.ingest({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    const completed = bridge.finalize(undefined).find((event) => event.event === "response.completed")!;
    expect(completed.data.response).toMatchObject({
      usage: {
        input_tokens: 29,
        output_tokens: 3,
        total_tokens: 32,
        input_tokens_details: { cached_tokens: 20 },
      },
    });
  });

  test("drops a truncated tool call instead of failing the response", () => {
    const bridge = new AnthropicStreamToResponses("resp_2");
    bridge.ingest({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "apply_patch" } });
    bridge.ingest({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"input\":\"*** Begi" } });
    const events = bridge.finalize("max_tokens");
    const incomplete = events.find((event) => event.event === "response.incomplete");
    expect(incomplete).toBeDefined();
    expect(incomplete!.data.response).toMatchObject({ incomplete_details: { reason: "max_output_tokens" }, output: [] });
  });
});

describe("gemini mapping", () => {
  test("maps effort to thinking levels Gemini accepts", () => {
    const level = (effort: string) => (googleRequestFromResponses({ input: [userText], reasoning: { effort } }, gemini).generationConfig as Record<string, unknown>).thinkingConfig;
    expect(level("minimal")).toEqual({ thinkingLevel: "low" });
    expect(level("xhigh")).toEqual({ thinkingLevel: "high" });
    expect(level("max")).toEqual({ thinkingLevel: "high" });
    expect(level("medium")).toEqual({ thinkingLevel: "medium" });
    expect(level("none")).toBeUndefined();
  });

  test("maps tool_choice none to the NONE function-calling mode", () => {
    const request = googleRequestFromResponses({
      input: [userText],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "none",
    }, gemini);
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  test("carries a function call's thoughtSignature through a reasoning item", () => {
    const bridge = new GoogleStreamToResponses("resp_3");
    bridge.ingest({
      candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "SIG+/=" }] } }],
    });
    const output = (bridge.finalize("STOP").find((event) => event.event === "response.completed")!
      .data.response as { output: Array<Record<string, unknown>> }).output;
    const reasoning = output.find((item) => item.type === "reasoning")!;
    const call = output.find((item) => item.type === "function_call")!;
    expect(output.indexOf(reasoning)).toBeLessThan(output.indexOf(call));
    expect(call.call_id).not.toContain("SIG");

    const next = googleRequestFromResponses({
      input: [
        reasoning,
        { type: "function_call", call_id: call.call_id, name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "function_call_output", call_id: call.call_id, output: "ok" },
      ],
    }, gemini);
    const modelTurn = (next.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find((turn) => turn.role === "model")!;
    expect(modelTurn.parts[0]).toEqual({ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "SIG+/=" });
  });

  test("ignores a reasoning item that another provider produced", () => {
    const bridge = new AnthropicStreamToResponses("resp_5");
    bridge.ingest({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    bridge.ingest({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "anth-sig" } });
    bridge.ingest({ type: "content_block_stop", index: 0 });
    const reasoning = (bridge.finalize("end_turn").find((event) => event.event === "response.completed")!
      .data.response as { output: Array<Record<string, unknown>> }).output[0]!;
    const foreign = googleRequestFromResponses({
      input: [reasoning, { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }],
    }, gemini);
    const modelTurn = (foreign.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find((turn) => turn.role === "model")!;
    expect(modelTurn.parts[0]).toEqual({ functionCall: { name: "lookup", args: {} } });
  });

});

describe("tool call completion", () => {
  const pending = (args: string) => ({ itemId: "fc_1", callId: "call_1", name: "apply_patch", args, announced: true, outputIndex: 0 });

  test("drops calls with cut-off arguments when the stream was truncated", () => {
    expect(finishedToolCalls([pending("{\"input\":\"*** Begi")], "max_tokens")).toEqual([]);
    expect(finishedToolCalls([pending("")], "end_turn")).toEqual([{ call: pending(""), args: "{}" }]);
  });

  test("keeps the strict failure for invalid arguments on a complete stream", () => {
    expect(() => finishedToolCalls([pending("{\"input\":")], "end_turn")).toThrow();
  });

  test("terminal events are incomplete for truncations and completed otherwise", () => {
    expect(terminalEvent("resp_4", [], undefined, "MAX_TOKENS").event).toBe("response.incomplete");
    expect(terminalEvent("resp_4", [], undefined, "STOP").event).toBe("response.completed");
    expect(zeroUsage().total_tokens).toBe(0);
  });
});

describe("anthropic signed thinking replay", () => {
  function streamTurn(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const bridge = new AnthropicStreamToResponses("resp_replay");
    const emitted = events.flatMap((event) => bridge.ingest(event));
    emitted.push(...bridge.finalize("tool_use"));
    return (emitted.find((event) => event.event === "response.completed")!.data.response as { output: Array<Record<string, unknown>> }).output;
  }

  const signedTurn = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should look it up." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } },
    { type: "content_block_stop", index: 1 },
  ];

  test("captures a signed thinking block as a reasoning item before the tool call", () => {
    const output = streamTurn(signedTurn);
    expect(output.map((item) => item.type)).toEqual(["reasoning", "function_call"]);
    expect(output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "I should look it up." }] });
    expect(typeof output[0]!.encrypted_content).toBe("string");
  });

  test("replays the signed block ahead of the tool call and keeps thinking on", () => {
    const output = streamTurn(signedTurn);
    const request = anthropicRequestFromResponses({
      input: [
        { type: "message", role: "user", content: "look up x" },
        ...output,
        { type: "function_call_output", call_id: output[1]!.call_id, output: "found" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "required",
      reasoning: { effort: "high" },
    }, claude("claude-sonnet-4-5"));
    const assistant = (request.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "I should look it up.", signature: "sig-abc" });
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "lookup" });
    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 7_168 });
    expect(request.tool_choice).toEqual({ type: "auto" });
  });

  test("replays redacted thinking the same way", () => {
    const output = streamTurn([
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "lookup", input: {} } },
      { type: "content_block_stop", index: 1 },
    ]);
    const request = anthropicRequestFromResponses({
      input: [{ type: "message", role: "user", content: "go" }, ...output, { type: "function_call_output", call_id: output[1]!.call_id, output: "ok" }],
      reasoning: { effort: "high" },
    }, claude("claude-sonnet-4-5"));
    const assistant = (request.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "redacted_thinking", data: "opaque" });
  });

  test("drops thinking for a manual tool turn with no signed block", () => {
    const request = anthropicRequestFromResponses({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "toolu_3", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "toolu_3", output: "ok" },
      ],
      reasoning: { effort: "high" },
    }, claude("claude-sonnet-4-5"));
    expect(request.thinking).toBeUndefined();
  });

  test("drops thinking and its signed block when the budget cannot fit", () => {
    const output = streamTurn(signedTurn);
    const request = anthropicRequestFromResponses({
      input: [{ type: "message", role: "user", content: "go" }, ...output, { type: "function_call_output", call_id: output[1]!.call_id, output: "ok" }],
      reasoning: { effort: "high" },
    }, claude("claude-sonnet-4-5", 1_024));
    expect(request.thinking).toBeUndefined();
    const assistant = (request.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((message) => message.role === "assistant")!;
    expect(assistant.content.some((block) => block.type === "thinking")).toBe(false);
  });
});
