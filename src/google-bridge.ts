import type { Oc3Model } from "./models";
import { responsesRequestToChat } from "./translate";
import {
  asRecord,
  chatText,
  numberOr,
  parseDataUrl,
  parseToolArguments,
  reasoningEffort,
  replayByCallId,
  ResponsesStream,
  usageRecord,
  type EmittedEvent,
} from "./bridge-common";
import { newId } from "./protocol";

export type { EmittedEvent } from "./bridge-common";

/** Convert a Responses API request body to a Gemini GenerateContent request body. */
export function googleRequestFromResponses(
  body: Record<string, unknown>,
  model: Oc3Model,
): Record<string, unknown> {
  const chat = responsesRequestToChat(body, model);
  const replays = replayByCallId(body.input);
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
      const replay = replays.get(call.id);
      parts.push({
        functionCall: {
          name: call.function.name,
          args: parseToolArguments(call.function.arguments),
        },
        ...(replay?.provider === "google" && replay.signature ? { thoughtSignature: replay.signature } : {}),
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
        mode: googleToolMode(chat.tool_choice),
      },
    };
  }
  return request;
}

/**
 * Ingests one parsed Gemini GenerateContent SSE event and emits Responses
 * events. `finalize` should receive the candidate finishReason when available.
 * A functionCall that carries a thoughtSignature is preceded by a reasoning
 * item whose replay payload holds that signature.
 */
export class GoogleStreamToResponses {
  private readonly stream: ResponsesStream;
  private stopReason: string | undefined;

  constructor(responseId: string) {
    this.stream = new ResponsesStream(responseId);
  }

  created(): EmittedEvent {
    return this.stream.created();
  }

  ingest(event: Record<string, unknown>): EmittedEvent[] {
    const events: EmittedEvent[] = [];
    const usage = asRecord(event.usageMetadata);
    if (usage) this.stream.setUsage(normalizedUsage(usage));

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
        if (value) events.push(...this.stream.reasoningDelta(value));
        continue;
      }
      if (value) {
        events.push(...this.stream.closeReasoning(), ...this.stream.appendText(value));
        continue;
      }
      const call = asRecord(part.functionCall);
      if (call && typeof call.name === "string" && call.name) {
        const signature = typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
        if (signature) {
          events.push(...this.stream.openReasoning(), ...this.stream.closeReasoning({ provider: "google", signature }));
        } else {
          events.push(...this.stream.closeReasoning());
        }
        const started = this.stream.startCall(newId("call"), call.name);
        events.push(...started.events, ...this.stream.appendCallArgs(started.call, JSON.stringify(call.args ?? {})));
      }
    }
    return events;
  }

  finalize(stopReason: string | undefined): EmittedEvent[] {
    return this.stream.finalize(stopReason ?? this.stopReason ?? "STOP");
  }
}

/**
 * Gemini accepts minimal through high. Codex's xhigh and max collapse to high,
 * and minimal maps to low, which every thinking model accepts. `none` omits the
 * thinking config.
 */
function googleThinkingPayload(reasoning: unknown, model: Oc3Model): Record<string, unknown> {
  const effort = reasoningEffort(reasoning);
  if (!model.reasoning || !effort || effort === "none") return {};
  return { thinkingConfig: { thinkingLevel: googleThinkingLevel(effort) } };
}

function googleThinkingLevel(effort: string): "low" | "medium" | "high" {
  if (effort === "medium") return "medium";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return "low";
}

function googleToolMode(choice: unknown): "NONE" | "ANY" | "AUTO" {
  if (choice === "none") return "NONE";
  if (choice === "required") return "ANY";
  return "AUTO";
}

/** Gemini reports thought tokens apart from candidate tokens; output includes them. */
function normalizedUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const input = numberOr(usage.promptTokenCount, 0);
  const thoughts = numberOr(usage.thoughtsTokenCount, 0);
  const output = numberOr(usage.candidatesTokenCount, 0) + thoughts;
  return usageRecord(
    input,
    output,
    numberOr(usage.totalTokenCount, input + output),
    numberOr(usage.cachedContentTokenCount, 0),
    thoughts,
  );
}

function googleImage(value: unknown): Record<string, unknown> | undefined {
  const image = parseDataUrl(value);
  if (!image) return undefined;
  return { inlineData: { mimeType: image.mediaType, data: image.data } };
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : undefined;
}
