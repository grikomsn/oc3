import { describe, expect, test } from "bun:test";
import { ChatStreamToResponses, parseSseData, responsesRequestToChat } from "../src/translate";
import type { Oc3Model } from "../src/models";

const chatModel: Oc3Model = {
  id: "acme/fast-model",
  rawModelId: "fast-model",
  providerId: "acme",
  name: "Fast",
  contextLength: 128000,
  maxOutputTokens: 8192,
  reasoning: false,
  imageInput: false,
  toolCalling: true,
  endpoint: "chat-completions",
  baseUrl: "https://example.test/v1",
};

describe("responsesRequestToChat", () => {
  test("maps instructions and text messages", () => {
    const result = responsesRequestToChat({
      instructions: "Be brief.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "bye" }] },
      ],
    }, chatModel);
    expect(result.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ]);
    expect(result.model).toBe("fast-model");
    expect(result.stream).toBe(true);
  });

  test("maps function calls and outputs to tool messages", () => {
    const result = responsesRequestToChat({
      input: [
        { type: "message", role: "user", content: "run it" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "call_1", output: "file.txt" },
      ],
      tools: [{ type: "function", name: "shell", description: "run shell", parameters: { type: "object" } }],
      tool_choice: "auto",
    }, chatModel);
    expect(result.messages![1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }],
    });
    expect(result.messages![2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file.txt" });
    expect(result.tools).toEqual([{ type: "function", function: { name: "shell", description: "run shell", parameters: { type: "object" } } }]);
    expect(result.tool_choice).toBe("auto");
  });
});

describe("ChatStreamToResponses", () => {
  test("converts text and usage chunks into responses events", () => {
    const converter = new ChatStreamToResponses("resp_1");
    const events = [
      ...converter.ingest({ choices: [{ delta: { content: "he" } }] }),
      ...converter.ingest({ choices: [{ delta: { content: "llo" } }] }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      ...converter.finalize("stop"),
    ];
    const names = events.map((event) => event.event);
    expect(names).toEqual([
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = events.at(-1)!.data.response as Record<string, unknown>;
    expect(completed.usage).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  });

  test("converts streamed tool calls into function_call items", () => {
    const converter = new ChatStreamToResponses("resp_2");
    const events = [
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "shell", arguments: "{\"c" } }] } }] }),
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "md\":\"ls\"}" } }] } }], }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...converter.finalize("tool_calls"),
    ];
    const added = events.filter((event) => event.event === "response.output_item.added");
    expect(added).toHaveLength(1);
    expect((added[0]!.data.item as Record<string, unknown>).type).toBe("function_call");
    const done = events.find((event) => event.event === "response.output_item.done")!;
    expect((done.data.item as Record<string, unknown>).arguments).toBe("{\"cmd\":\"ls\"}");
  });
});

describe("parseSseData", () => {
  test("parses data lines and skips DONE", () => {
    expect(parseSseData('data: {"a":1}')).toEqual({ a: 1 });
    expect(parseSseData("data: [DONE]")).toBeUndefined();
    expect(parseSseData("event: something")).toBeUndefined();
  });
});
