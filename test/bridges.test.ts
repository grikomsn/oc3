import { describe, expect, test } from "bun:test";
import { AnthropicStreamToResponses, anthropicRequestFromResponses } from "../src/anthropic-bridge";
import { GoogleStreamToResponses, googleRequestFromResponses } from "../src/google-bridge";
import type { Oc3Model } from "../src/models";

const anthropicModel: Oc3Model = {
  id: "acme/claude-sonnet",
  rawModelId: "claude-sonnet",
  providerId: "acme",
  name: "Claude Sonnet",
  contextLength: 200_000,
  maxOutputTokens: 8_192,
  reasoning: true,
  imageInput: true,
  toolCalling: true,
  endpoint: "messages",
  baseUrl: "https://example.test",
};

const googleModel: Oc3Model = {
  id: "acme/gemini-flash",
  rawModelId: "gemini-flash",
  providerId: "acme",
  name: "Gemini Flash",
  contextLength: 128_000,
  maxOutputTokens: 4_096,
  reasoning: true,
  imageInput: true,
  toolCalling: true,
  endpoint: "google",
  baseUrl: "https://example.test",
};

describe("anthropicRequestFromResponses", () => {
  test("maps system, text, images, tool calls, and tool results", () => {
    const request = anthropicRequestFromResponses({
      instructions: "Be careful.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What is this?" },
            { type: "input_image", image_url: "data:image/png;base64,QUJD" },
          ],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"query\":\"status\"}" },
        { type: "function_call_output", call_id: "call_1", output: "all good" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Look up state", parameters: { type: "object" } }],
      tool_choice: "required",
      reasoning: { effort: "high" },
    }, anthropicModel);

    expect(request.model).toBe("claude-sonnet");
    expect(request.system).toBe("Be careful.");
    expect(request.max_tokens).toBe(8_192);
    expect(request.stream).toBe(true);
    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 7_168 });
    expect(request.tools).toEqual([
      { name: "lookup", description: "Look up state", input_schema: { type: "object" } },
    ]);
    expect(request.tool_choice).toEqual({ type: "any" });
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { query: "status" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "all good" }],
      },
    ]);
  });

  test("omits thinking for low effort and uses auto when tools are optional", () => {
    const request = anthropicRequestFromResponses({
      input: "hello",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      reasoning: { effort: "low" },
    }, anthropicModel);
    expect(request.thinking).toBeUndefined();
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });
});

describe("AnthropicStreamToResponses", () => {
  test("emits text, usage, and completion", () => {
    const bridge = new AnthropicStreamToResponses("resp_a");
    const events = [
      bridge.created(),
      ...bridge.ingest({ type: "message_start", message: { usage: { input_tokens: 11 } } }),
      ...bridge.ingest({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      ...bridge.ingest({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      ...bridge.ingest({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      ...bridge.finalize("end_turn"),
    ];
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const added = events[1]!.data.item as Record<string, unknown>;
    const done = events[4]!.data.item as Record<string, unknown>;
    expect(added.id).toBe(done.id);
    expect(done.content).toEqual([{ type: "output_text", text: "Hello world", annotations: [] }]);
    const completed = events[5]!.data.response as Record<string, unknown>;
    expect(completed.usage).toEqual({
      input_tokens: 11,
      output_tokens: 3,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("emits thinking deltas", () => {
    const bridge = new AnthropicStreamToResponses("resp_b");
    const events = bridge.ingest({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "checking input" },
    });
    expect(events[0]!.event).toBe("response.reasoning_summary_text.delta");
    expect(events[0]!.data.delta).toBe("checking input");
  });

  test("converts tool_use blocks into function_call output", () => {
    const bridge = new AnthropicStreamToResponses("resp_c");
    const events = [
      ...bridge.ingest({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      }),
      ...bridge.ingest({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"query\":\"stat" },
      }),
      ...bridge.ingest({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "us\"}" },
      }),
      ...bridge.finalize("end_turn"),
    ];
    const added = events.find((event) => event.event === "response.output_item.added")!;
    const item = added.data.item as Record<string, unknown>;
    expect(item.call_id).toBe("toolu_1");
    expect(item.name).toBe("lookup");
    const deltas = events.filter((event) => event.event === "response.function_call_arguments.delta");
    expect(deltas.map((event) => event.data.delta)).toEqual(["{\"query\":\"stat", "us\"}"]);
    const done = events.find((event) => event.event === "response.output_item.done")!;
    expect(done.data.item).toEqual({
      type: "function_call",
      id: item.id,
      call_id: "toolu_1",
      name: "lookup",
      arguments: "{\"query\":\"status\"}",
    });
  });

  test("maps max_tokens and refusal to incomplete", () => {
    const maxBridge = new AnthropicStreamToResponses("resp_d");
    maxBridge.ingest({ type: "content_block_delta", delta: { type: "text_delta", text: "part" } });
    const maxEvents = maxBridge.finalize("max_tokens");
    expect(maxEvents.at(-1)!.event).toBe("response.incomplete");
    expect((maxEvents.at(-1)!.data.response as Record<string, unknown>).incomplete_details)
      .toEqual({ reason: "max_output_tokens" });

    const filterBridge = new AnthropicStreamToResponses("resp_e");
    filterBridge.ingest({ type: "content_block_delta", delta: { type: "text_delta", text: "no" } });
    const filterEvents = filterBridge.finalize("refusal");
    expect(filterEvents.at(-1)!.event).toBe("response.incomplete");
    expect((filterEvents.at(-1)!.data.response as Record<string, unknown>).incomplete_details)
      .toEqual({ reason: "content_filter" });
  });
});

describe("googleRequestFromResponses", () => {
  test("maps system, text, images, function calls, and function responses", () => {
    const request = googleRequestFromResponses({
      instructions: "Be concise.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe this." },
            { type: "input_image", image_url: "data:image/jpeg;base64,SU1H" },
          ],
        },
        { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{\"query\":\"weather\"}" },
        { type: "function_call_output", call_id: "call_2", output: "sunny" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Get data", parameters: { type: "object" } }],
      tool_choice: "required",
      reasoning: { effort: "high" },
    }, googleModel);

    expect(request.systemInstruction).toEqual({ parts: [{ text: "Be concise." }] });
    expect(request.generationConfig).toEqual({
      maxOutputTokens: 4_096,
      thinkingConfig: { thinkingLevel: "high" },
    });
    expect(request.tools).toEqual([{
      functionDeclarations: [{ name: "lookup", description: "Get data", parameters: { type: "object" } }],
    }]);
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(request.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Describe this." },
          { inlineData: { mimeType: "image/jpeg", data: "SU1H" } },
        ],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "lookup", args: { query: "weather" } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "lookup", response: { content: "sunny" } } }],
      },
    ]);
  });

  test("maps optional tool mode and disables explicit thinking for none", () => {
    const request = googleRequestFromResponses({
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      reasoning: { effort: "none" },
    }, googleModel);
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(request.generationConfig).toEqual({ maxOutputTokens: 4_096 });
  });
});

describe("GoogleStreamToResponses", () => {
  test("emits text, thinking, tools, usage, and completion", () => {
    const bridge = new GoogleStreamToResponses("resp_f");
    const events = [
      bridge.created(),
      ...bridge.ingest({
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }],
      }),
      ...bridge.ingest({
        candidates: [{ content: { parts: [{ text: "Answer" }] } }],
      }),
      ...bridge.ingest({
        candidates: [{
          content: { parts: [{ functionCall: { name: "lookup", args: { query: "status" } } }] },
          finishReason: "STOP",
        }],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 2,
          totalTokenCount: 13,
        },
      }),
      ...bridge.finalize("STOP"),
    ];
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const callAdded = events[4]!.data.item as Record<string, unknown>;
    const callDone = events[8]!.data.item as Record<string, unknown>;
    expect(callAdded.id).toBe(callDone.id);
    expect(callDone).toEqual({
      type: "function_call",
      id: callDone.id,
      call_id: callDone.call_id,
      name: "lookup",
      arguments: "{\"query\":\"status\"}",
    });
    const completed = events[9]!.data.response as Record<string, unknown>;
    expect(completed.usage).toEqual({
      input_tokens: 7,
      output_tokens: 4,
      total_tokens: 13,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    });
  });

  test("maps MAX_TOKENS and SAFETY to incomplete", () => {
    const maxBridge = new GoogleStreamToResponses("resp_g");
    maxBridge.ingest({ candidates: [{ content: { parts: [{ text: "part" }] } }] });
    const maxEvents = maxBridge.finalize("MAX_TOKENS");
    expect(maxEvents.at(-1)!.event).toBe("response.incomplete");
    expect((maxEvents.at(-1)!.data.response as Record<string, unknown>).incomplete_details)
      .toEqual({ reason: "max_output_tokens" });

    const safetyBridge = new GoogleStreamToResponses("resp_h");
    safetyBridge.ingest({ candidates: [{ content: { parts: [{ text: "no" }] } }] });
    const safetyEvents = safetyBridge.finalize("SAFETY");
    expect(safetyEvents.at(-1)!.event).toBe("response.incomplete");
    expect((safetyEvents.at(-1)!.data.response as Record<string, unknown>).incomplete_details)
      .toEqual({ reason: "content_filter" });
  });
});
