import type { Oc3Model } from "./models";
import { newId } from "./protocol";

export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  tool_choice?: "auto" | "required" | "none";
}

export function responsesRequestToChat(body: Record<string, unknown>, model: Oc3Model): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [];
  const instructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions.trim() : undefined;
  if (instructions) messages.push({ role: "system", content: instructions });

  const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  for (const item of input) {
    appendResponsesItem(messages, item);
  }

  const tools = Array.isArray(body.tools) ? (body.tools as ResponsesTool[]) : [];
  const chatTools = tools.flatMap((tool): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> => {
    if (tool.type !== "function" || !tool.name) return [];
    return [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } } }];
  });

  const request: ChatCompletionRequest = {
    model: model.rawModelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof body.max_output_tokens === "number") request.max_tokens = body.max_output_tokens;
  else request.max_tokens = model.maxOutputTokens;
  if (chatTools.length) {
    request.tools = chatTools;
    request.tool_choice = toolChoice(body.tool_choice);
  }
  return request;
}

function appendResponsesItem(messages: ChatCompletionMessage[], item: unknown): void {
  if (typeof item === "string") {
    messages.push({ role: "user", content: item });
    return;
  }
  if (!item || typeof item !== "object") return;
  const record = item as Record<string, unknown>;
  const type = str(record.type) ?? "message";
  if (type === "message") {
    const role = str(record.role) === "assistant" ? "assistant" : str(record.role) === "system" || str(record.role) === "developer" ? "system" : "user";
    messages.push({ role, content: contentToText(record.content) });
    return;
  }
  if (type === "function_call") {
    const callId = str(record.call_id) ?? str(record.id) ?? `call_${messages.length}`;
    const name = str(record.name) ?? "";
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name, arguments: str(record.arguments) ?? "{}" } }],
    });
    return;
  }
  if (type === "function_call_output") {
    messages.push({
      role: "tool",
      tool_call_id: str(record.call_id) ?? "call",
      content: contentToText(record.output),
    });
    return;
  }
  if (type === "reasoning") return;
  const fallbackRole = str(record.role);
  if (fallbackRole) {
    messages.push({ role: fallbackRole === "assistant" ? "assistant" : "user", content: contentToText(record.content) });
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "number") return String(content);
  if (!Array.isArray(content)) return "";
  return content.flatMap((part): string[] => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    const type = str(record.type) ?? "";
    if (type === "input_text" || type === "output_text" || type === "text" || type === "refusal") {
      return str(record.text) ? [record.text as string] : [];
    }
    return [];
  }).join("\n");
}

function toolChoice(value: unknown): "auto" | "required" | "none" {
  if (value === "required") return "required";
  if (value === "none") return "none";
  return "auto";
}

export interface EmittedEvent {
  event: string;
  data: Record<string, unknown>;
}

export class ChatStreamToResponses {
  private readonly itemId: string;
  private readonly callId: string;
  private text = "";
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string; announced: boolean; index: number }>();
  private outputIndex = 0;
  private messageAnnounced = false;
  private usage: Record<string, unknown> | undefined;

  constructor(private readonly responseId: string) {
    this.itemId = newId("msg");
    this.callId = newId("fc");
  }

  created(): EmittedEvent {
    return {
      event: "response.created",
      data: { type: "response.created", response: { id: this.responseId } },
    };
  }

  ingest(chunk: Record<string, unknown>): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    const usage = record(chunk.usage);
    if (usage) {
      this.usage = {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? ((Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0))),
      };
    }
    const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : undefined;
    if (!choice) return events;
    const delta = record(choice.delta) ?? {};
    const contentDelta = typeof delta.content === "string" ? delta.content : undefined;
    if (contentDelta) {
      if (!this.messageAnnounced) {
        this.messageAnnounced = true;
        events.push({
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: this.outputIndex,
            item: { type: "message", id: this.itemId, role: "assistant", content: [] },
          },
        });
      }
      this.text += contentDelta;
      events.push({
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          item_id: this.itemId,
          output_index: this.outputIndex,
          content_index: 0,
          delta: contentDelta,
        },
      });
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCall of toolCalls) {
      const call = record(rawToolCall);
      if (!call) continue;
      const index = typeof call.index === "number" ? call.index : this.toolCalls.size;
      const existing = this.toolCalls.get(index) ?? {
        id: str(call.id) ?? newId("call"),
        name: "",
        args: "",
        announced: false,
        index: this.outputIndex + 1 + this.toolCalls.size,
      };
      const fn = record(call.function);
      if (fn) {
        if (str(fn.name) && !existing.name) existing.name = str(fn.name) ?? "";
        if (typeof fn.arguments === "string") existing.args += fn.arguments;
      }
      if (str(call.id)) existing.id = str(call.id) as string;
      if (!existing.announced) {
        existing.announced = true;
        events.push({
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: existing.index,
            item: { type: "function_call", id: newId("fc"), call_id: existing.id, name: existing.name, arguments: "" },
          },
        });
      }
      events.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: existing.id,
          output_index: existing.index,
          delta: typeof fn?.arguments === "string" ? fn.arguments : "",
        },
      });
      this.toolCalls.set(index, existing);
    }
    return events;
  }

  finalize(finishReason: string | undefined): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    if (this.messageAnnounced) {
      events.push({
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: this.outputIndex,
          item: {
            type: "message",
            id: this.itemId,
            role: "assistant",
            content: [{ type: "output_text", text: this.text, annotations: [] }],
          },
        },
      });
      this.outputIndex += 1;
    }
    for (const call of [...this.toolCalls.values()].sort((a, b) => a.index - b.index)) {
      events.push({
        event: "response.function_call_arguments.done",
        data: { type: "response.function_call_arguments.done", item_id: call.id, output_index: call.index, arguments: call.args },
      });
      events.push({
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: call.index,
          item: { type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.args },
        },
      });
    }
    const output: Array<Record<string, unknown>> = [];
    if (this.messageAnnounced) {
      output.push({ type: "message", id: this.itemId, role: "assistant", content: [{ type: "output_text", text: this.text, annotations: [] }] });
    }
    for (const call of [...this.toolCalls.values()].sort((a, b) => a.index - b.index)) {
      output.push({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.args });
    }
    events.push({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: this.responseId,
          output,
          usage: this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    });
    return events;
  }
}

export function formatSseEvent(event: EmittedEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function parseSseData(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    const value = JSON.parse(payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
