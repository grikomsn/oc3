import type { EndpointKind } from "./protocol";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingFamily = "openai" | "deepseek" | "glm" | "kimi" | "minimax" | "mimo" | "qwen";

export function thinkingFamily(modelId: string, catalogFamily?: string): ThinkingFamily | undefined {
  const id = bareModelId(modelId);
  const family = catalogFamily?.toLowerCase() ?? "";
  if (id.startsWith("gpt-")) return "openai";
  if (id.startsWith("deepseek-")) return "deepseek";
  if (id.startsWith("glm-")) return "glm";
  if (id.startsWith("kimi-")) return "kimi";
  if (id.startsWith("minimax-")) return "minimax";
  if (id.startsWith("mimo-")) return "mimo";
  if (/^qwen3(?:\.|-)/.test(id)) return "qwen";
  if (family === "gpt" || family.startsWith("gpt-") || family === "openai") return "openai";
  if (family.startsWith("deepseek")) return "deepseek";
  if (family.startsWith("glm")) return "glm";
  if (family.startsWith("kimi")) return "kimi";
  if (family.startsWith("minimax")) return "minimax";
  if (family.startsWith("mimo")) return "mimo";
  if (family.startsWith("qwen")) return "qwen";
  return undefined;
}

function bareModelId(modelId: string): string {
  return modelId.toLowerCase().split("/").at(-1) ?? modelId.toLowerCase();
}

/**
 * Wire fields a chat-completions model needs to honor the Responses request's
 * reasoning.effort. Adapted from opencode-copilot-chat src/models/options.ts
 * thinkingPayload. `undefined` means the effort maps to nothing on this wire.
 */
export function reasoningWirePayload(family: ThinkingFamily, modelId: string, endpoint: EndpointKind, effort: ReasoningEffort): Record<string, unknown> {
  const off = effort === "none" || effort === "minimal";
  switch (family) {
    case "qwen":
      if (endpoint === "messages") return off ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" } };
      return off ? { enable_thinking: false } : { enable_thinking: true };
    case "kimi":
      if (/^kimi-k2\.7/i.test(bareModelId(modelId))) return { thinking: { type: "enabled", keep: "all" } };
      return { thinking: { type: off ? "disabled" : "enabled" } };
    case "minimax":
      if (off) return {};
      return { thinking: { type: /^minimax-m2\./i.test(bareModelId(modelId)) ? "enabled" : "adaptive" } };
    case "glm":
      if (off) return { thinking: { type: "disabled" } };
      return { reasoning_effort: effort };
    case "mimo":
      if (off) return {};
      return { reasoning_effort: effort };
    case "deepseek":
      if (off) return {};
      return {};
    case "openai":
      return { reasoning_effort: effort };
  }
}
