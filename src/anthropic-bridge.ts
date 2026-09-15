import type { Oc3Model } from "./models";
import { newId } from "./protocol";
import { responsesRequestToChat } from "./translate";
import { truncatedStopReason } from "./stop-reason";

export interface EmittedEvent {
  event: string;
  data: Record<string, unknown>;
}

interface PendingToolCall {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  announced: boolean;
  outputIndex: number;
}

/** Convert a Responses API request body to an Anthropic Messages request body. */
export function anthropicRequestFromResponses(
  body: Record<string, unknown>,
  model: Oc3Model,
): Record<string, unknown> {
  const chat = responsesRequestToChat(body, model);
  const messages: Array<Record<string, unknown>> = [];
  const system: string[] = [];

  for (const message of chat.messages) {
    if (message.role === "system") {
      system.push(chatText(message.content));
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "tool",
          content: chatText(message.content),
        }],
      });
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string") {
      if (message.content) content.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = asRecord(rawPart);
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          content.push({ type: "text", text: part.text });
          continue;
        }
        if (part.type === "image_url") {
          const image = anthropicImage(part.image_url);
          if (image) content.push(image);
        }
      }
    }
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
      });
    }

    messages.push({
      role: message.role,
      content: content.length ? content : chatText(message.content),
    });
  }

  const maxTokens = chat.max_tokens ?? model.maxOutputTokens;
  const request: Record<string, unknown> = {
    model: model.rawModelId,
    messages: messages.length ? messages : [{ role: "user", content: "Continue the conversation." }],
    max_tokens: maxTokens,
    stream: true,
  };
  if (system.length) request.system = system.join("\n\n");
  if (chat.tools?.length) {
    request.tools = chat.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    request.tool_choice = chat.tool_choice === "required" ? { type: "any" } : { type: "auto" };
  }

  const effort = reasoningEffort(body.reasoning);
  const thinking = anthropicThinkingPayload(model, effort, maxTokens);
  if (thinking) request.thinking = thinking;
  return request;
}

/**
 * Ingests one parsed Anthropic Messages SSE event and emits Responses events.
 * Unlike ChatStreamToResponses, the message item is announced on the first
 * visible text delta, because a thinking-only stream has no assistant text item.
 */
export class AnthropicStreamToResponses {
  private readonly itemId: string;
  private readonly tools = new Map<string, PendingToolCall>();
  private text = "";
  private outputIndex = 0;
  private messageAnnounced = false;
  private stopReason: string | undefined;
  private usage: Record<string, unknown> | undefined;

  constructor(private readonly responseId: string) {
    this.itemId = newId("msg");
  }

  created(): EmittedEvent {
    return {
      event: "response.created",
      data: { type: "response.created", response: { id: this.responseId } },
    };
  }

  ingest(event: Record<string, unknown>): EmittedEvent[] {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start") {
      const message = asRecord(event.message);
      const usage = asRecord(message?.usage);
      if (usage) this.usage = normalizedUsage(usage);
      return [];
    }
    if (type === "content_block_start") return this.contentBlockStart(event);
    if (type === "content_block_delta") return this.contentBlockDelta(event);
    if (type === "message_delta") {
      const delta = asRecord(event.delta);
      if (delta && typeof delta.stop_reason === "string") this.stopReason = delta.stop_reason;
      const usage = asRecord(event.usage);
      if (usage) this.usage = normalizedUsage(usage, this.usage);
      return [];
    }
    if (type === "error") {
      const error = asRecord(event.error);
      return [{
        event: "error",
        data: {
          type: "error",
          message: typeof error?.message === "string" && error.message
            ? error.message
            : "Anthropic stream returned an error",
        },
      }];
    }
    return [];
  }

  finalize(stopReason: string | undefined): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    const reason = stopReason ?? this.stopReason ?? "end_turn";
    if (this.messageAnnounced) {
      events.push(this.messageDoneEvent());
      this.outputIndex += 1;
    }

    const calls = [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const call of calls) {
      const args = call.args.trim() || "{}";
      JSON.parse(args);
      events.push({
        event: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: call.itemId,
          output_index: call.outputIndex,
          arguments: args,
        },
      });
      events.push({
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: call.outputIndex,
          item: {
            type: "function_call",
            id: call.itemId,
            call_id: call.callId,
            name: call.name,
            arguments: args,
          },
        },
      });
    }

    const output: Array<Record<string, unknown>> = [];
    if (this.messageAnnounced) {
      output.push({
        type: "message",
        id: this.itemId,
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      });
    }
    for (const call of calls) {
      output.push({
        type: "function_call",
        id: call.itemId,
        call_id: call.callId,
        name: call.name,
        arguments: call.args.trim() || "{}",
      });
    }

    const truncation = truncatedStopReason(reason);
    if (truncation) {
      events.push({
        event: "response.incomplete",
        data: {
          type: "response.incomplete",
          response: {
            id: this.responseId,
            output,
            usage: this.usage ?? zeroUsage(),
            incomplete_details: {
              reason: truncation === "max_output_tokens" ? "max_output_tokens" : "content_filter",
            },
          },
        },
      });
      return events;
    }
    events.push({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: { id: this.responseId, output, usage: this.usage ?? zeroUsage() },
      },
    });
    return events;
  }

  private contentBlockStart(event: Record<string, unknown>): EmittedEvent[] {
    const block = asRecord(event.content_block);
    if (block?.type !== "tool_use") return [];
    const index = indexKey(event.index);
    const input = asRecord(block.input);
    const existing: PendingToolCall = {
      itemId: newId("fc"),
      callId: typeof block.id === "string" && block.id ? block.id : newId("call"),
      name: typeof block.name === "string" ? block.name : "",
      args: input && Object.keys(input).length ? JSON.stringify(input) : "",
      announced: false,
      outputIndex: this.nextToolOutputIndex(),
    };
    this.tools.set(index, existing);
    return this.announceTool(existing);
  }

  private contentBlockDelta(event: Record<string, unknown>): EmittedEvent[] {
    const delta = asRecord(event.delta);
    if (!delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      const events: EmittedEvent[] = [];
      if (!this.messageAnnounced) {
        this.messageAnnounced = true;
        events.push(this.messageAddedEvent());
      }
      this.text += delta.text;
      events.push({
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          item_id: this.itemId,
          output_index: this.outputIndex,
          content_index: 0,
          delta: delta.text,
        },
      });
      return events;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      return [{
        event: "response.reasoning_summary_text.delta",
        data: {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning",
          output_index: 0,
          summary_index: 0,
          delta: delta.thinking,
        },
      }];
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const call = this.tools.get(indexKey(event.index));
      if (!call) return [];
      call.args += delta.partial_json;
      const announced = this.announceTool(call);
      announced.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: call.itemId,
          output_index: call.outputIndex,
          delta: delta.partial_json,
        },
      });
      return announced;
    }
    return [];
  }

  private announceTool(call: PendingToolCall): EmittedEvent[] {
    if (call.announced) return [];
    call.announced = true;
    return [{
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: call.outputIndex,
        item: {
          type: "function_call",
          id: call.itemId,
          call_id: call.callId,
          name: call.name,
          arguments: "",
        },
      },
    }];
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
        item: {
          type: "message",
          id: this.itemId,
          role: "assistant",
          content: [{ type: "output_text", text: this.text, annotations: [] }],
        },
      },
    };
  }

  private nextToolOutputIndex(): number {
    return this.outputIndex + 1 + this.tools.size;
  }
}

/**
 * Effort values understood by Codex are limited to a subset of Anthropic's
 * thinking controls. Enable thinking only for high-or-greater requests.
 */
function anthropicThinkingPayload(model: Oc3Model, effort: string | undefined, maxTokens: number): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  if (effort !== "high" && effort !== "xhigh" && effort !== "max") return undefined;
  // Anthropic requires budget_tokens >= 1024 and < max_tokens.
  const budget = Math.min(16_384, Math.max(1_024, maxTokens - 1_024));
  return { type: "enabled", budget_tokens: budget };
}

function normalizedUsage(usage: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> {
  const base = previous ?? {};
  const input = numberOr(usage.input_tokens, numberOr(base.input_tokens, 0));
  const output = numberOr(usage.output_tokens, numberOr(base.output_tokens, 0));
  const cached = numberOr(usage.cache_read_input_tokens, numberOr(base.input_tokens_details ? (asRecord(base.input_tokens_details)?.cached_tokens as unknown) : 0, 0));
  const reasoning = numberOr(usage.reasoning_tokens, numberOr(base.output_tokens_details ? (asRecord(base.output_tokens_details)?.reasoning_tokens as unknown) : 0, 0));
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOr(usage.total_tokens, input + output),
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function zeroUsage(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function anthropicImage(value: unknown): Record<string, unknown> | undefined {
  const url = typeof value === "string"
    ? value
    : typeof asRecord(value)?.url === "string"
      ? asRecord(value)?.url as string
      : undefined;
  const match = /^data:(.+?);base64,(.+)$/.exec(url ?? "");
  if (!match) return undefined;
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
  };
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

function reasoningEffort(value: unknown): string | undefined {
  const record = asRecord(value);
  return record && typeof record.effort === "string" ? record.effort : undefined;
}

function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const record = asRecord(part);
    return record && typeof record.text === "string" ? record.text : "";
  }).join("\n");
}

function indexKey(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && value ? value : "0";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
