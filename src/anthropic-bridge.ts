import type { Oc3Model } from "./models";
import { responsesRequestToChat } from "./translate";
import {
  asRecord,
  chatText,
  numberOr,
  parseDataUrl,
  parseToolArguments,
  PendingToolCall,
  reasoningEffort,
  replayByCallId,
  ResponsesStream,
  usageRecord,
  type EmittedEvent,
} from "./bridge-common";

export type { EmittedEvent } from "./bridge-common";

/** Convert a Responses API request body to an Anthropic Messages request body. */
export function anthropicRequestFromResponses(
  body: Record<string, unknown>,
  model: Oc3Model,
): Record<string, unknown> {
  const chat = responsesRequestToChat(body, model);
  const replays = replayByCallId(body.input);
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
    const replay = message.tool_calls?.length ? replays.get(message.tool_calls[0]!.id) : undefined;
    if (replay?.provider === "anthropic" && replay.blocks) content.unshift(...replay.blocks);

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
  const finalTurn = finalAssistantContent(messages);
  const finalTurnCallsTools = finalTurn.some((block) => asRecord(block)?.type === "tool_use");
  const finalTurnSigned = finalTurn.some(isThinkingBlock);
  const thinking = anthropicThinkingPayload(model, reasoningEffort(body.reasoning), maxTokens, finalTurnCallsTools && !finalTurnSigned);
  if (!thinking) stripThinkingBlocks(messages);
  if (chat.tools?.length) {
    request.tools = chat.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    request.tool_choice = anthropicToolChoice(chat.tool_choice, thinking, model.rawModelId);
  }
  if (thinking) request.thinking = thinking;
  return request;
}

type OpenBlock =
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; call: PendingToolCall };

/**
 * Ingests one parsed Anthropic Messages SSE event and emits Responses events.
 * Thinking blocks become reasoning items whose replay payload carries the
 * signed block, so the next turn can send it back.
 */
export class AnthropicStreamToResponses {
  private readonly stream: ResponsesStream;
  private readonly open = new Map<string, OpenBlock>();
  private stopReason: string | undefined;
  private rawUsage: Record<string, unknown> = {};

  constructor(responseId: string) {
    this.stream = new ResponsesStream(responseId);
  }

  created(): EmittedEvent {
    return this.stream.created();
  }

  ingest(event: Record<string, unknown>): EmittedEvent[] {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start") {
      this.recordUsage(asRecord(asRecord(event.message)?.usage));
      return [];
    }
    if (type === "content_block_start") return this.contentBlockStart(event);
    if (type === "content_block_delta") return this.contentBlockDelta(event);
    if (type === "content_block_stop") return this.contentBlockStop(event);
    if (type === "message_delta") {
      const delta = asRecord(event.delta);
      if (delta && typeof delta.stop_reason === "string") this.stopReason = delta.stop_reason;
      this.recordUsage(asRecord(event.usage));
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
    const reason = stopReason ?? this.stopReason ?? "end_turn";
    if (Object.keys(this.rawUsage).length) this.stream.setUsage(anthropicUsage(this.rawUsage));
    return this.stream.finalize(reason);
  }

  private recordUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value)) this.rawUsage[key] = value;
    }
  }

  private contentBlockStart(event: Record<string, unknown>): EmittedEvent[] {
    const index = indexKey(event.index);
    const block = asRecord(event.content_block);
    if (block?.type === "thinking") {
      this.open.set(index, { kind: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", signature: "" });
      return this.stream.openReasoning();
    }
    if (block?.type === "redacted_thinking") {
      this.open.set(index, { kind: "redacted", data: typeof block.data === "string" ? block.data : "" });
      return this.stream.openReasoning();
    }
    if (block?.type !== "tool_use") return [];
    const { call, events } = this.stream.startCall(
      typeof block.id === "string" && block.id ? block.id : `call_${index}`,
      typeof block.name === "string" ? block.name : "",
    );
    const input = asRecord(block.input);
    if (input && Object.keys(input).length) call.args = JSON.stringify(input);
    this.open.set(index, { kind: "tool", call });
    return events;
  }

  private contentBlockDelta(event: Record<string, unknown>): EmittedEvent[] {
    const index = indexKey(event.index);
    const delta = asRecord(event.delta);
    if (!delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      return this.stream.appendText(delta.text);
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      this.thinkingBlock(index).thinking += delta.thinking;
      return this.stream.reasoningDelta(delta.thinking);
    }
    if (delta.type === "signature_delta" && typeof delta.signature === "string") {
      this.thinkingBlock(index).signature += delta.signature;
      return [];
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const block = this.open.get(index);
      if (block?.kind !== "tool") return [];
      return this.stream.appendCallArgs(block.call, delta.partial_json);
    }
    return [];
  }

  private contentBlockStop(event: Record<string, unknown>): EmittedEvent[] {
    const index = indexKey(event.index);
    const block = this.open.get(index);
    this.open.delete(index);
    if (block?.kind === "thinking") {
      const replay = block.signature
        ? { provider: "anthropic" as const, blocks: [{ type: "thinking", thinking: block.thinking, signature: block.signature }] }
        : undefined;
      return this.stream.closeReasoning(replay);
    }
    if (block?.kind === "redacted") {
      return this.stream.closeReasoning({ provider: "anthropic", blocks: [{ type: "redacted_thinking", data: block.data }] });
    }
    return [];
  }

  private thinkingBlock(index: string): Extract<OpenBlock, { kind: "thinking" }> {
    const existing = this.open.get(index);
    if (existing?.kind === "thinking") return existing;
    const created: Extract<OpenBlock, { kind: "thinking" }> = { kind: "thinking", thinking: "", signature: "" };
    this.open.set(index, created);
    return created;
  }
}

/**
 * Manual `enabled` thinking needs 1024 <= budget_tokens < max_tokens, and Claude 4.7
 * and later reject it outright, so those models use adaptive thinking. A manual
 * request whose final assistant turn calls tools needs that turn to start with a
 * signed thinking block; without one the request is sent without thinking.
 * Thinking is only enabled for high-or-greater requests.
 */
function anthropicThinkingPayload(
  model: Oc3Model,
  effort: string | undefined,
  maxTokens: number,
  manualBlockedByToolTurn: boolean,
): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  if (effort !== "high" && effort !== "xhigh" && effort !== "max") return undefined;
  if (requiresAdaptiveThinking(model.rawModelId)) return { type: "adaptive" };
  if (manualBlockedByToolTurn || maxTokens < 2_048) return undefined;
  return { type: "enabled", budget_tokens: Math.min(16_384, maxTokens - 1_024) };
}

/** Claude 4.7 and later (including 5.x) only accept adaptive thinking. */
export function requiresAdaptiveThinking(rawModelId: string): boolean {
  const match = /claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(\d+)(?:[.-](\d+))?/i.exec(rawModelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 4 || (major === 4 && minor >= 7);
}

/** Forced tool use is incompatible with thinking, so thinking turns fall back to auto. */
/**
 * Forced tool use (`any`) conflicts with manual thinking. Adaptive thinking allows
 * it, except on the models that reject it.
 */
function anthropicToolChoice(choice: unknown, thinking: Record<string, unknown> | undefined, rawModelId: string): Record<string, unknown> {
  if (choice === "none") return { type: "none" };
  const forcedAllowed = thinking === undefined || (thinking.type === "adaptive" && !rejectsForcedToolUse(rawModelId));
  if (choice === "required" && forcedAllowed) return { type: "any" };
  return { type: "auto" };
}

function rejectsForcedToolUse(rawModelId: string): boolean {
  return /claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/i.test(rawModelId.replace(/\./g, "-"));
}

function finalAssistantContent(messages: Array<Record<string, unknown>>): unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") return Array.isArray(message.content) ? message.content : [];
  }
  return [];
}

function isThinkingBlock(block: unknown): boolean {
  const record = asRecord(block);
  if (record?.type === "redacted_thinking") return true;
  return record?.type === "thinking" && typeof record.signature === "string" && record.signature.length > 0;
}

function stripThinkingBlocks(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.filter((block) => {
      const type = asRecord(block)?.type;
      return type !== "thinking" && type !== "redacted_thinking";
    });
  }
}

/** Anthropic reports cache reads and writes apart from input_tokens; fold them back in. */
function anthropicUsage(raw: Record<string, unknown>): Record<string, unknown> {
  const cached = numberOr(raw.cache_read_input_tokens, 0);
  const created = numberOr(raw.cache_creation_input_tokens, 0);
  const input = numberOr(raw.input_tokens, 0) + cached + created;
  const output = numberOr(raw.output_tokens, 0);
  return usageRecord(input, output, undefined, cached, 0);
}

function anthropicImage(value: unknown): Record<string, unknown> | undefined {
  const image = parseDataUrl(value);
  if (!image) return undefined;
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  };
}

function indexKey(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && value ? value : "0";
}
