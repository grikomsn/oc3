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
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "bye" }] },
    ]);
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
      tool_choice: "required",
    }, chatModel);
    expect(result.messages![1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }],
    });
    expect(result.messages![2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file.txt" });
    expect(result.tools).toEqual([{ type: "function", function: { name: "shell", description: "run shell", parameters: { type: "object" } } }]);
    expect(result.tool_choice).toBe("required");
  });

  test("pairs local_shell_call with its output", () => {
    const result = responsesRequestToChat({
      input: [
        { type: "local_shell_call", call_id: "call_ls", action: { command: ["ls", "-la"] } },
        { type: "function_call_output", call_id: "call_ls", output: "done" },
      ],
    }, chatModel);
    expect(result.messages![0]!.tool_calls).toEqual([
      { id: "call_ls", type: "function", function: { name: "shell", arguments: "{\"command\":[\"ls\",\"-la\"]}" } },
    ]);
    expect(result.messages![1]).toEqual({ role: "tool", tool_call_id: "call_ls", content: "done" });
  });

  test("annotates empty tool outputs", () => {
    const result = responsesRequestToChat({
      input: [
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "   " },
      ],
    }, chatModel);
    expect(result.messages![1]!.content).toContain("empty tool output");
  });

  test("bridges freeform custom tools and object tool_choice", () => {
    const result = responsesRequestToChat({
      input: [{ type: "message", role: "user", content: "patch it" }],
      tools: [{ type: "custom", name: "apply_patch", description: "patch" }],
      tool_choice: { type: "function", name: "apply_patch" },
    }, chatModel);
    expect(result.tools![0]!.function.name).toBe("apply_patch");
    expect(result.tools![0]!.function.parameters.required).toEqual(["input"]);
    expect(result.tool_choice).toEqual({ type: "function", function: { name: "apply_patch" } });
  });

  test("passes images through for message content", () => {
    const result = responsesRequestToChat({
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] }],
    }, chatModel);
    expect(result.messages![0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  test("applies family-specific reasoning wire format", () => {
    const glm: Oc3Model = { ...chatModel, rawModelId: "glm-5.3", name: "glm" };
    const result = responsesRequestToChat({
      reasoning: { effort: "high" },
    }, glm);
    expect(result).toMatchObject({ reasoning_effort: "high" });
    const qwen: Oc3Model = { ...chatModel, rawModelId: "qwen3-max" };
    const qwenResult = responsesRequestToChat({ reasoning: { effort: "none" } }, qwen);
    expect(qwenResult).toMatchObject({ enable_thinking: false });
  });
});

describe("ChatStreamToResponses", () => {
  test("converts text and usage chunks into responses events with strict details", () => {
    const converter = new ChatStreamToResponses("resp_1");
    const events = [
      ...converter.ingest({ choices: [{ delta: { content: "he" } }] }),
      ...converter.ingest({ choices: [{ delta: { content: "llo" } }] }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } } }),
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
    expect(completed.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 1 },
    });
  });

  test("converts streamed tool calls with a stable item id and coerced args", () => {
    const converter = new ChatStreamToResponses("resp_2", new Map([
      ["wait", { type: "object", properties: { yield_time_ms: { type: "number" } } }],
    ]));
    const events = [
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "wait", arguments: "{\"yield_time_ms\": 1200" } }] } }] }),
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: ".0}" } }] } }] }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...converter.finalize("tool_calls"),
    ];
    const added = events.find((event) => event.event === "response.output_item.added")!;
    const itemId = (added.data.item as Record<string, unknown>).id;
    const deltas = events.filter((event) => event.event === "response.function_call_arguments.delta");
    expect(deltas.every((event) => event.data.item_id === itemId)).toBe(true);
    const done = events.find((event) => event.event === "response.output_item.done")!;
    expect((done.data.item as Record<string, unknown>).arguments).toBe("{\"yield_time_ms\":1200}");
  });

  test("errors on unparseable tool arguments instead of completing", () => {
    const converter = new ChatStreamToResponses("resp_3");
    const events = [
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "{\"broken" } }] } }] }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...converter.finalize("tool_calls"),
    ];
    const error = events.find((event) => event.event === "error");
    expect(error).toBeDefined();
    expect(events.some((event) => event.event === "response.completed")).toBe(false);
  });

  test("maps truncated finish reasons to response.incomplete", () => {
    const converter = new ChatStreamToResponses("resp_4");
    converter.ingest({ choices: [{ delta: { content: "partial" } }] });
    const events = converter.finalize("length");
    const incomplete = events.find((event) => event.event === "response.incomplete")!;
    expect(incomplete).toBeDefined();
    expect((incomplete.data.response as Record<string, unknown>).incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(events.some((event) => event.event === "response.completed")).toBe(false);
  });

  test("emits reasoning deltas from reasoning_content", () => {
    const converter = new ChatStreamToResponses("resp_5");
    const events = converter.ingest({ choices: [{ delta: { reasoning_content: "thinking..." } }] });
    expect(events[0]!.event).toBe("response.reasoning_summary_text.delta");
    expect(events[0]!.data.delta).toBe("thinking...");
  });

  test("repairs decorated apply_patch payloads", () => {
    const converter = new ChatStreamToResponses("resp_6");
    const decorated = JSON.stringify({ input: "*** Begin Patch ***\n*** Add File: a.txt\n+hi\n*** End Patch ***" });
    const events = [
      ...converter.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "apply_patch", arguments: decorated } }] } }] }),
      ...converter.ingest({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...converter.finalize("tool_calls"),
    ];
    const done = events.find((event) => event.event === "response.output_item.done")!;
    const args = JSON.parse((done.data.item as Record<string, unknown>).arguments as string) as { input: string };
    expect(args.input).toBe("*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch");
  });
});

describe("parseSseData", () => {
  test("parses data lines and skips DONE", () => {
    expect(parseSseData('data: {"a":1}')).toEqual({ a: 1 });
    expect(parseSseData("data: [DONE]")).toBeUndefined();
    expect(parseSseData("event: something")).toBeUndefined();
  });
});
