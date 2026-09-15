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

/** Convert a Responses API request body to a Gemini GenerateContent request body. */
export function googleRequestFromResponses(
  body: Record<string, unknown>,
  model: Oc3Model,
): Record<string, unknown> {
  const chat = responsesRequestToChat(body, model);
  const contents: Array<Record<string, unknown>> = [];
  const system: string[] = [];
  const toolNames = new Map<string, string>();

  for (const message of chat.messages) {
    if (message.role === "system") {
      system.push(chatText(message.content));
      continue;
    }
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: toolNames.get(message.tool_call_id ?? "") ?? "tool",
            response: { content: chatText(message.content) },
          },
        }],
      });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (message.role === "assistant" && typeof message.reasoning_content === "string" && message.reasoning_content) {
      parts.push({ text: message.reasoning_content, thought: true });
    }
    if (typeof message.content === "string") {
      if (message.content) parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = asRecord(rawPart);
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          parts.push({ text: part.text });
          continue;
        }
        const inline = googleImage(part.image_url);
        if (inline) parts.push(inline);
      }
    }
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
      parts.push({
        functionCall: {
          name: call.function.name,
          args: parseToolArguments(call.function.arguments),
        },
      });
    }
    if (parts.length) {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
  }

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: chat.max_tokens ?? model.maxOutputTokens,
    ...googleThinkingPayload(body.reasoning, model),
  };
  const request: Record<string, unknown> = {
    contents: contents.length
      ? contents
      : [{ role: "user", parts: [{ text: "Continue the conversation." }] }],
    generationConfig,
  };
  if (system.length) {
    request.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  }
  if (chat.tools?.length) {
    request.tools = [{
      functionDeclarations: chat.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    }];
    request.toolConfig = {
      functionCallingConfig: {
        mode: chat.tool_choice === "required" ? "ANY" : "AUTO",
      },
    };
  }
  return request;
}

/**
 * Ingests one parsed Gemini GenerateContent SSE event and emits Responses
 * events. `finalize` should receive the candidate finishReason when available.
 */
export class GoogleStreamToResponses {
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
    const events: EmittedEvent[] = [];
    const usage = asRecord(event.usageMetadata);
    if (usage) this.usage = normalizedUsage(usage);

    const candidate = firstRecord(event.candidates);
    if (!candidate) return events;
    const finishReason = candidate.finishReason;
    if (typeof finishReason === "string" && finishReason) this.stopReason = finishReason;

    const content = asRecord(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;
      const value = typeof part.text === "string" ? part.text : "";
      if (part.thought === true) {
        if (value) {
          events.push({
            event: "response.reasoning_summary_text.delta",
            data: {
              type: "response.reasoning_summary_text.delta",
              item_id: "reasoning",
              output_index: 0,
              summary_index: 0,
              delta: value,
            },
          });
        }
        continue;
      }
      if (value) {
        if (!this.messageAnnounced) {
          this.messageAnnounced = true;
          events.push(this.messageAddedEvent());
        }
        this.text += value;
        events.push({
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: this.itemId,
            output_index: this.outputIndex,
            content_index: 0,
            delta: value,
          },
        });
        continue;
      }
      const call = asRecord(part.functionCall);
      if (call && typeof call.name === "string" && call.name) {
        const args = JSON.stringify(call.args ?? {});
        const pending: PendingToolCall = {
          itemId: newId("fc"),
          callId: newId("call"),
          name: call.name,
          args,
          announced: false,
          outputIndex: this.nextToolOutputIndex(),
        };
        const key = `${this.tools.size}:${call.name}:${args}`;
        this.tools.set(key, pending);
        events.push(...this.announceTool(pending));
        events.push({
          event: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            item_id: pending.itemId,
            output_index: pending.outputIndex,
            delta: args,
          },
        });
      }
    }
    return events;
  }

  finalize(stopReason: string | undefined): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    const reason = stopReason ?? this.stopReason ?? "STOP";
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

function googleThinkingPayload(reasoning: unknown, model: Oc3Model): Record<string, unknown> {
  const effort = reasoningEffort(reasoning);
  if (!model.reasoning || !effort || effort === "none") return {};
  return { thinkingConfig: { thinkingLevel: effort } };
}

function normalizedUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const input = numberOr(usage.promptTokenCount, 0);
  const output = numberOr(usage.candidatesTokenCount, 0);
  const reasoning = numberOr(usage.thoughtsTokenCount, 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOr(usage.totalTokenCount, input + output),
    input_tokens_details: { cached_tokens: numberOr(usage.cachedContentTokenCount, 0) },
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

function googleImage(value: unknown): Record<string, unknown> | undefined {
  const url = typeof value === "string"
    ? value
    : typeof asRecord(value)?.url === "string"
      ? asRecord(value)?.url as string
      : undefined;
  const match = /^data:(.+?);base64,(.+)$/.exec(url ?? "");
  if (!match) return undefined;
  return { inlineData: { mimeType: match[1], data: match[2] } };
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

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
