import type { Oc3Model } from "./models";
import { newId } from "./protocol";
import { truncatedStopReason } from "./stop-reason";
import { asRecord, zeroUsage, type EmittedEvent } from "./bridge-common";

export type { EmittedEvent };
import { coerceToolArguments, isCompletePatchEnvelope, normalizeApplyPatchDelimiters } from "./tool-args-repair";

export const EMPTY_TOOL_OUTPUT_ANNOTATION =
  "[oc3] empty tool output: the tool ran but produced no stdout or return value; do not treat this as success, failure, or user-provided input.";

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
  reasoning_content?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: true;
}

export function responsesRequestToChat(body: Record<string, unknown>, model: Oc3Model): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [];
  const instructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions.trim() : undefined;
  if (instructions) messages.push({ role: "system", content: instructions });

  const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  const callIds: string[] = [];
  for (const item of input) {
    appendResponsesItem(messages, item, callIds);
  }

  const tools = Array.isArray(body.tools) ? (body.tools as ResponsesTool[]) : [];
  const chatTools = tools.flatMap((tool): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> => {
    if (tool.type === "function" && tool.name) {
      return [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } } }];
    }
    // Freeform custom tools (e.g. apply_patch) carry a string `input` payload;
    // bridge them as single-string-parameter functions.
    if (tool.type === "custom" && tool.name) {
      return [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input." } }, required: ["input"] } } }];
    }
    return [];
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
    if (body.parallel_tool_calls === true) request.parallel_tool_calls = true;
  }
  return request;
}

function appendResponsesItem(messages: ChatCompletionMessage[], item: unknown, callIds: string[]): void {
  if (typeof item === "string") {
    messages.push({ role: "user", content: item });
    return;
  }
  if (!item || typeof item !== "object") return;
  const record = item as Record<string, unknown>;
  const type = str(record.type) ?? "message";
  if (type === "message") {
    const role = chatRole(str(record.role));
    messages.push({ role, content: contentToParts(record.content), ...(role === "assistant" && str(record.reasoning_content) ? { reasoning_content: str(record.reasoning_content) } : {}) });
    return;
  }
  if (type === "function_call" || type === "local_shell_call") {
    const callId = str(record.call_id) ?? str(record.id) ?? `call_${messages.length}`;
    callIds.push(callId);
    let name = str(record.name) ?? "";
    let args = str(record.arguments) ?? "{}";
    if (type === "local_shell_call") {
      name = name || "shell";
      const command = record.action && typeof record.action === "object" && Array.isArray((record.action as Record<string, unknown>).command)
        ? (record.action as Record<string, unknown>).command as unknown[]
        : [];
      args = JSON.stringify(command.length ? { command: command.map(String) } : {});
    }
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
    });
    return;
  }
  if (type === "function_call_output") {
    const text = contentToText(record.output);
    messages.push({
      role: "tool",
      tool_call_id: str(record.call_id) ?? callIds.at(-1) ?? "call",
      content: text.trim() ? text : EMPTY_TOOL_OUTPUT_ANNOTATION,
    });
    return;
  }
  if (type === "reasoning") return;
  const fallbackRole = str(record.role);
  if (fallbackRole) {
    messages.push({ role: chatRole(fallbackRole), content: contentToParts(record.content) });
  }
}

// Responses `developer` instructions carry system-level authority, so they map to the chat `system` role.
function chatRole(role: string | undefined): "system" | "user" | "assistant" {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function contentToParts(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (typeof content === "number") return String(content);
  if (!Array.isArray(content)) return "";
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    const type = str(item.type) ?? "";
    if (type === "input_text" || type === "output_text" || type === "text" || type === "refusal") {
      const text = type === "refusal" ? item.refusal : item.text;
      if (str(text)) parts.push({ type: "text", text });
    } else if (type === "input_image") {
      const url = typeof item.image_url === "string" ? item.image_url : str((item.image_url as Record<string, unknown> | undefined)?.url);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts;
}

function contentToText(content: unknown): string {
  const parts = contentToParts(content);
  if (typeof parts === "string") return parts;
  return parts.map((part) => typeof part.text === "string" ? part.text : "").join("\n");
}

function toolChoice(value: unknown): "auto" | "required" | "none" | { type: "function"; function: { name: string } } {
  if (value === "required") return "required";
  if (value === "none") return "none";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const type = str(record.type);
    const name = typeof record.name === "string" ? record.name : str((record.function as Record<string, unknown> | undefined)?.name);
    if ((type === "function" || type === "custom") && name) return { type: "function", function: { name } };
  }
  return "auto";
}


function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}


interface PendingToolCall {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  announced: boolean;
  outputIndex: number;
}

export class ChatStreamToResponses {
  private readonly itemId: string;
  private text = "";
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private outputIndex = 0;
  private messageAnnounced = false;
  private usage: Record<string, unknown> | undefined;
  private finishReason: string | undefined;
  private readonly repairSchemas: ReadonlyMap<string, Record<string, unknown>>;

  constructor(private readonly responseId: string, toolSchemas?: ReadonlyMap<string, Record<string, unknown>>) {
    this.itemId = newId("msg");
    this.repairSchemas = toolSchemas ?? new Map();
  }

  created(): EmittedEvent {
    return {
      event: "response.created",
      data: { type: "response.created", response: { id: this.responseId } },
    };
  }

  ingest(chunk: Record<string, unknown>): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    const usage = asRecord(chunk.usage);
    if (usage) this.usage = normalizedUsage(usage);
    const choice = Array.isArray(chunk.choices) ? asRecord(chunk.choices[0]) : undefined;
    if (!choice) return events;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = asRecord(choice.delta) ?? {};

    const reasoning = [delta.reasoning_content, delta.reasoning]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (reasoning) {
      events.push({
        event: "response.reasoning_summary_text.delta",
        data: { type: "response.reasoning_summary_text.delta", item_id: "reasoning", output_index: 0, summary_index: 0, delta: reasoning },
      });
    }

    const contentDelta = typeof delta.content === "string" ? delta.content : undefined;
    if (contentDelta) {
      if (!this.messageAnnounced) {
        this.messageAnnounced = true;
        events.push(this.messageAddedEvent());
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
      const call = asRecord(rawToolCall);
      if (!call) continue;
      const index = typeof call.index === "number" ? call.index : this.toolCalls.size;
      const existing = this.toolCalls.get(index) ?? {
        itemId: newId("fc"),
        callId: str(call.id) ?? newId("call"),
        name: "",
        args: "",
        announced: false,
        outputIndex: this.nextToolOutputIndex(),
      };
      const fn = asRecord(call.function);
      if (fn) {
        if (typeof fn.name === "string" && fn.name) existing.name += fn.name;
        if (typeof fn.arguments === "string") existing.args += fn.arguments;
      }
      if (str(call.id)) existing.callId = str(call.id) as string;
      if (!existing.announced) {
        existing.announced = true;
        events.push({
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: existing.outputIndex,
            item: { type: "function_call", id: existing.itemId, call_id: existing.callId, name: existing.name, arguments: "" },
          },
        });
      }
      events.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: existing.itemId,
          output_index: existing.outputIndex,
          delta: typeof fn?.arguments === "string" ? fn.arguments : "",
        },
      });
      this.toolCalls.set(index, existing);
    }
    return events;
  }

  finalize(finishReason?: string): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    if (this.messageAnnounced) {
      events.push(this.messageDoneEvent());
      this.outputIndex += 1;
    }
    const calls: Array<{ call: PendingToolCall; args: string }> = [];
    for (const call of [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      const args = this.finalArguments(call);
      if (args === undefined) {
        return [{ event: "error", data: { type: "error", message: `Tool call ${call.name} ended with invalid arguments; not completing the item.` } }];
      }
      calls.push({ call, args });
    }
    for (const { call, args } of calls) {
      events.push({
        event: "response.function_call_arguments.done",
        data: { type: "response.function_call_arguments.done", item_id: call.itemId, output_index: call.outputIndex, arguments: args },
      });
      events.push(this.toolDoneEvent(call, args));
    }

    const output: Array<Record<string, unknown>> = [];
    if (this.messageAnnounced) output.push(this.messageItem());
    for (const { call, args } of calls) {
      output.push({ type: "function_call", id: call.itemId, call_id: call.callId, name: call.name, arguments: args });
    }

    const response = { id: this.responseId, output, usage: this.usage ?? zeroUsage() };
    const truncation = truncatedStopReason(finishReason ?? this.finishReason);
    if (truncation) {
      events.push({
        event: "response.incomplete",
        data: { type: "response.incomplete", response: { ...response, incomplete_details: { reason: truncation } } },
      });
    } else {
      events.push({ event: "response.completed", data: { type: "response.completed", response } });
    }
    return events;
  }

  private finalArguments(call: PendingToolCall): string | undefined {
    const args = coerceToolArguments(call.args.trim() || "{}", this.repairSchemas.get(call.name), call.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
    if (call.name !== "apply_patch") return args;
    const input = asRecord(parsed)?.input;
    if (typeof input !== "string" || !isCompletePatchEnvelope(input)) return args;
    return JSON.stringify({ input: normalizeApplyPatchDelimiters(input) });
  }

  private nextToolOutputIndex(): number {
    return this.outputIndex + 1 + this.toolCalls.size;
  }

  private messageAddedEvent(): EmittedEvent {
    return {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: this.outputIndex,
        item: { type: "message", id: this.itemId, role: "assistant", content: [] },
      },
    };
  }

  private messageDoneEvent(): EmittedEvent {
    return {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item: this.messageItem(),
      },
    };
  }

  private messageItem(): Record<string, unknown> {
    return {
      type: "message",
      id: this.itemId,
      role: "assistant",
      content: [{ type: "output_text", text: this.text, annotations: [] }],
    };
  }

  private toolDoneEvent(call: PendingToolCall, args: string): EmittedEvent {
    return {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: call.outputIndex,
        item: { type: "function_call", id: call.itemId, call_id: call.callId, name: call.name, arguments: args },
      },
    };
  }
}

function normalizedUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: typeof promptDetails?.cached_tokens === "number" ? promptDetails.cached_tokens : 0 },
    output_tokens_details: { reasoning_tokens: typeof completionDetails?.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : 0 },
  };
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
