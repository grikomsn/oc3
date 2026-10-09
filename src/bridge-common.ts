// Helpers shared by the Anthropic and Gemini bridges: the Responses event
// shapes, tool-call bookkeeping, the OpenAI-style usage contract, and the
// reasoning items that carry provider signatures across turns.
//
// Usage contract (what Codex expects): input_tokens includes cached tokens,
// output_tokens includes reasoning tokens, and total_tokens is their sum.
//
// Replay contract: a provider's thinking signature is returned as a reasoning
// item whose encrypted_content is an opaque payload Codex echoes back in
// history. replayByCallId() reads those payloads so the next request can send
// the signed block with the tool call it belongs to.

import { newId } from "./protocol";
import { truncatedStopReason } from "./stop-reason";

export interface EmittedEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface PendingToolCall {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  announced: boolean;
  outputIndex: number;
}

/** What a bridge needs to send a provider's signed reasoning back on the next turn. */
export interface ReplayPayload {
  provider: "anthropic" | "google";
  blocks?: Array<Record<string, unknown>>;
  signature?: string;
}

export function zeroUsage(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

export function usageRecord(input: number, output: number, total: number | undefined, cached: number, reasoning: number): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total ?? input + output,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const record = asRecord(part);
    return record && typeof record.text === "string" ? record.text : "";
  }).join("\n");
}

export function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

export function reasoningEffort(value: unknown): string | undefined {
  const record = asRecord(value);
  return record && typeof record.effort === "string" ? record.effort : undefined;
}

/** A base64 data URL (from an image part) split into its media type and payload. */
export function parseDataUrl(value: unknown): { mediaType: string; data: string } | undefined {
  const url = typeof value === "string"
    ? value
    : typeof asRecord(value)?.url === "string"
      ? asRecord(value)?.url as string
      : undefined;
  const match = /^data:(.+?);base64,(.+)$/.exec(url ?? "");
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

// base64url, not encryption. The thinking text it carries also appears in the
// reasoning item's summary, so encrypting only this field would protect nothing.
export function encodeReplay(payload: ReplayPayload): string {
  return Buffer.from(JSON.stringify({ oc3: 1, ...payload }), "utf8").toString("base64url");
}

export function decodeReplay(value: unknown): ReplayPayload | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const record = asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (record?.oc3 !== 1) return undefined;
    const provider = record.provider === "anthropic" || record.provider === "google" ? record.provider : undefined;
    if (!provider) return undefined;
    const blocks = Array.isArray(record.blocks)
      ? record.blocks.flatMap((block) => asRecord(block) ? [asRecord(block)!] : [])
      : undefined;
    return {
      provider,
      blocks,
      signature: typeof record.signature === "string" ? record.signature : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Maps each function_call's call_id to the replay payload of the reasoning item
 * that immediately precedes it. Only the first call after a reasoning item gets
 * the payload, matching where providers put their signatures.
 */
export function replayByCallId(input: unknown): Map<string, ReplayPayload> {
  const replays = new Map<string, ReplayPayload>();
  if (!Array.isArray(input)) return replays;
  let pending: ReplayPayload | undefined;
  for (const item of input) {
    const record = asRecord(item);
    if (record?.type === "reasoning") {
      pending = decodeReplay(record.encrypted_content);
      continue;
    }
    if (record?.type === "function_call" && typeof record.call_id === "string") {
      if (pending) replays.set(record.call_id, pending);
    }
    pending = undefined;
  }
  return replays;
}

/** The finished tool calls for a stream. When the stream was cut off by the token
 * limit, a call whose arguments are not complete JSON is dropped rather than
 * failing the whole response, so the response can still end as incomplete. A
 * complete stream keeps the strict behavior: invalid arguments throw.
 */
export function finishedToolCalls(calls: PendingToolCall[], stopReason: string): Array<{ call: PendingToolCall; args: string }> {
  const truncated = truncatedStopReason(stopReason) !== undefined;
  const finished: Array<{ call: PendingToolCall; args: string }> = [];
  for (const call of calls) {
    const args = call.args.trim() || "{}";
    try {
      JSON.parse(args);
    } catch (error) {
      if (!truncated) throw error;
      continue;
    }
    finished.push({ call, args });
  }
  return finished;
}

function messageAddedEvent(itemId: string, outputIndex: number): EmittedEvent {
  return {
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { type: "message", id: itemId, role: "assistant", content: [] },
    },
  };
}

function messageDoneEvent(itemId: string, outputIndex: number, text: string): EmittedEvent {
  return {
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
  };
}

function messageOutput(itemId: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id: itemId,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function announceTool(call: PendingToolCall): EmittedEvent[] {
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

function toolCallDoneEvents(call: PendingToolCall, args: string): EmittedEvent[] {
  return [
    {
      event: "response.function_call_arguments.done",
      data: {
        type: "response.function_call_arguments.done",
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: args,
      },
    },
    {
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
    },
  ];
}

function toolCallOutput(call: PendingToolCall, args: string): Record<string, unknown> {
  return {
    type: "function_call",
    id: call.itemId,
    call_id: call.callId,
    name: call.name,
    arguments: args,
  };
}

/** The terminal response event: incomplete when the stop reason is a truncation, else completed. */
export function terminalEvent(
  responseId: string,
  output: Array<Record<string, unknown>>,
  usage: Record<string, unknown> | undefined,
  stopReason: string,
): EmittedEvent {
  const truncation = truncatedStopReason(stopReason);
  if (truncation) {
    return {
      event: "response.incomplete",
      data: {
        type: "response.incomplete",
        response: {
          id: responseId,
          output,
          usage: usage ?? zeroUsage(),
          incomplete_details: {
            reason: truncation === "max_output_tokens" ? "max_output_tokens" : "content_filter",
          },
        },
      },
    };
  }
  return {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: { id: responseId, output, usage: usage ?? zeroUsage() },
    },
  };
}

interface OutputEntry {
  index: number;
  item: Record<string, unknown>;
}

/**
 * The Responses event stream for one bridged turn. Items take output indexes in
 * the order the provider produces them, so a reasoning item (when a signature
 * exists) sits before the text or tool call that follows it. Provider stream
 * classes translate their events into these calls.
 */
export class ResponsesStream {
  private nextIndex = 0;
  private readonly messageId = newId("msg");
  private messageIndex: number | undefined;
  private text = "";
  private readonly reasoningEntries: OutputEntry[] = [];
  private openReasoningItem: { itemId: string; index: number; summary: string } | undefined;
  private readonly calls: PendingToolCall[] = [];
  private usage: Record<string, unknown> | undefined;

  constructor(private readonly responseId: string) {}

  created(): EmittedEvent {
    return {
      event: "response.created",
      data: { type: "response.created", response: { id: this.responseId } },
    };
  }

  setUsage(usage: Record<string, unknown>): void {
    this.usage = usage;
  }

  appendText(delta: string): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    if (this.messageIndex === undefined) {
      this.messageIndex = this.nextIndex;
      this.nextIndex += 1;
      events.push(messageAddedEvent(this.messageId, this.messageIndex));
    }
    this.text += delta;
    events.push({
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: this.messageId,
        output_index: this.messageIndex,
        content_index: 0,
        delta,
      },
    });
    return events;
  }

  /** Opens the reasoning item if none is open. Summary deltas must reference an open item. */
  openReasoning(): EmittedEvent[] {
    if (this.openReasoningItem) return [];
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.openReasoningItem = { itemId: newId("rs"), index, summary: "" };
    return [{
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: index,
        item: { type: "reasoning", id: this.openReasoningItem.itemId, summary: [] },
      },
    }];
  }

  reasoningDelta(delta: string): EmittedEvent[] {
    const events = this.openReasoning();
    const open = this.openReasoningItem;
    if (!open) return events;
    open.summary += delta;
    events.push({
      event: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        item_id: open.itemId,
        output_index: open.index,
        summary_index: 0,
        delta,
      },
    });
    return events;
  }

  /** Closes the open reasoning item. Its replay payload, when present, is what the next request sends back. */
  closeReasoning(replay?: ReplayPayload): EmittedEvent[] {
    const open = this.openReasoningItem;
    if (!open) return [];
    this.openReasoningItem = undefined;
    const item: Record<string, unknown> = {
      type: "reasoning",
      id: open.itemId,
      summary: open.summary ? [{ type: "summary_text", text: open.summary }] : [],
    };
    if (replay) item.encrypted_content = encodeReplay(replay);
    this.reasoningEntries.push({ index: open.index, item });
    return [{
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: open.index, item },
    }];
  }

  startCall(callId: string, name: string): { call: PendingToolCall; events: EmittedEvent[] } {
    const call: PendingToolCall = {
      itemId: newId("fc"),
      callId,
      name,
      args: "",
      announced: false,
      outputIndex: this.nextIndex,
    };
    this.nextIndex += 1;
    this.calls.push(call);
    return { call, events: announceTool(call) };
  }

  appendCallArgs(call: PendingToolCall, delta: string): EmittedEvent[] {
    call.args += delta;
    return [{
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: call.itemId,
        output_index: call.outputIndex,
        delta,
      },
    }];
  }

  finalize(stopReason: string): EmittedEvent[] {
    const events: EmittedEvent[] = this.closeReasoning();
    const entries: OutputEntry[] = [...this.reasoningEntries];
    if (this.messageIndex !== undefined) {
      events.push(messageDoneEvent(this.messageId, this.messageIndex, this.text));
      entries.push({ index: this.messageIndex, item: messageOutput(this.messageId, this.text) });
    }
    for (const { call, args } of finishedToolCalls(this.calls, stopReason)) {
      events.push(...toolCallDoneEvents(call, args));
      entries.push({ index: call.outputIndex, item: toolCallOutput(call, args) });
    }
    const output = entries.sort((a, b) => a.index - b.index).map((entry) => entry.item);
    events.push(terminalEvent(this.responseId, output, this.usage, stopReason));
    return events;
  }
}
