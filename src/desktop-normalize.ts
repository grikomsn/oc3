// Request normalization for ChatGPT desktop / Codex traffic, adapted from
// ollama's internal/proxy/codex_desktop_normalize.go and _autoreview.go.

import type { Oc3Model } from "./models";
import { normalizeReasoningEffort, type ThinkingMetadata } from "./routing-catalog";
import { reasoningWirePayload, thinkingFamily } from "./reasoning";

export const AUTO_REVIEW_MODEL = "codex-auto-review";
export const GUARDIAN_TOOL_NAME = "submit_guardian_decision";

export function modelKey(slug: string): string {
  return slug.trim().toLowerCase().replace(/\[.*\]$/, "");
}

// --- Full-Access exec tool normalization ---
// When Codex runs with sandbox_mode danger-full-access, strip require_escalated
// from exec_command's advertised schema. If a model echoes it, Codex rejects
// the entire command because its approval policy is Never.

export function normalizeFullAccessExecTool(body: Record<string, unknown>, sandboxMode: string | undefined): { body: Record<string, unknown>; changed: boolean } {
  if (sandboxMode !== "danger-full-access") return { body, changed: false };
  const tools = body.tools;
  if (!Array.isArray(tools)) return { body, changed: false };
  let changed = false;
  const next = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const record = tool as Record<string, unknown>;
    if (record.name !== "exec_command") return tool;
    const parameters = record.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return tool;
    const params = { ...(parameters as Record<string, unknown>) };
    const properties = params.properties && typeof params.properties === "object" && !Array.isArray(params.properties)
      ? { ...(params.properties as Record<string, unknown>) }
      : undefined;
    let schemaChanged = false;
    if (properties && "require_escalated" in properties) {
      delete properties.require_escalated;
      schemaChanged = true;
    }
    if (Array.isArray(params.required)) {
      const required = (params.required as unknown[]).filter((entry) => entry !== "require_escalated");
      if (required.length !== (params.required as unknown[]).length) {
        params.required = required;
        schemaChanged = true;
      }
    }
    if (!schemaChanged) return tool;
    changed = true;
    return { ...record, parameters: { ...params, ...(properties ? { properties } : {}) } };
  });
  if (!changed) return { body, changed: false };
  return { body: { ...body, tools: next }, changed: true };
}

// --- auto-review alias resolution ---

export interface TurnMetadata {
  turnId?: string;
  parentTurnId?: string;
}

export function extractTurnMetadata(body: Record<string, unknown>): { turnId?: string; parentTurnId?: string } {
  const metadata = body.client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  return {
    turnId: typeof record.turn_id === "string" ? record.turn_id : undefined,
    parentTurnId: typeof record.parent_turn_id === "string" ? record.parent_turn_id : undefined,
  };
}

export class TurnModelCache {
  private readonly models = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly limit: number;

  constructor(limit = 2048) {
    this.limit = limit;
  }

  remember(turnId: string | undefined, model: string): void {
    if (!turnId?.trim() || !model.trim()) return;
    if (this.models.has(turnId)) {
      this.models.set(turnId, model);
      return;
    }
    if (this.order.length >= this.limit) {
      const oldest = this.order.shift();
      if (oldest) this.models.delete(oldest);
    }
    this.models.set(turnId, model);
    this.order.push(turnId);
  }

  lookup(turnId: string | undefined): string | undefined {
    return turnId ? this.models.get(turnId) : undefined;
  }
}

export function resolveAutoReview(
  requestedModel: string,
  body: Record<string, unknown>,
  cache: TurnModelCache,
  defaultModel: string | undefined,
): { model: string; body: Record<string, unknown>; rewritten: boolean } | undefined {
  if (modelKey(requestedModel) !== AUTO_REVIEW_MODEL) {
    const { turnId } = extractTurnMetadata(body);
    cache.remember(turnId, requestedModel);
    return undefined;
  }
  let selected = defaultModel;
  if (!selected) return undefined;
  const { parentTurnId } = extractTurnMetadata(body);
  const turnModel = cache.lookup(parentTurnId);
  if (turnModel) selected = turnModel;
  return { model: selected, body: { ...body, model: selected }, rewritten: true };
}

// --- input item conversion for custom tool calls ---

export function normalizeInputItems(body: Record<string, unknown>): { body: Record<string, unknown>; changed: boolean } {
  const input = body.input;
  if (!Array.isArray(input)) return { body, changed: false };
  let changed = false;
  const next = input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.type === "custom_tool_call") {
      changed = true;
      return {
        type: "function_call",
        id: record.id,
        call_id: record.call_id ?? record.id,
        name: record.name,
        input: record.input,
        arguments: typeof record.input === "string" ? record.input : JSON.stringify(record.input ?? {}),
      };
    }
    if (record.type === "custom_tool_call_output") {
      changed = true;
      return { type: "function_call_output", call_id: record.call_id ?? record.id, output: record.output };
    }
    return item;
  });
  return changed ? { body: { ...body, input: next }, changed } : { body, changed: false };
}

// --- reasoning effort normalization against a model's thinking metadata ---

export function normalizeReasoningForModel(body: Record<string, unknown>, model: Oc3Model, thinking: ThinkingMetadata | undefined): Record<string, unknown> {
  if (!thinking || !thinking.supported) {
    if (!("reasoning" in body)) return body;
    const next = { ...body };
    delete next.reasoning;
    return next;
  }
  const reasoning = body.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return body;
  const effortRaw = (reasoning as Record<string, unknown>).effort;
  if (typeof effortRaw !== "string") return body;
  const normalized = normalizeReasoningEffort(effortRaw, thinking);
  const nextReasoning = { ...(reasoning as Record<string, unknown>) };
  const next = { ...body };
  if (!normalized) {
    // Omit stale effort selections so the model uses its default.
    delete nextReasoning.effort;
  } else {
    nextReasoning.effort = normalized;
  }
  next.reasoning = nextReasoning;
  if (Object.keys(nextReasoning).length === 0) delete next.reasoning;
  return next;
}

// Apply oc3's per-family reasoning wire format for chat-completions models
// before sending upstream (responses passthrough keeps native reasoning).
export function applyReasoningWire(body: Record<string, unknown>, model: Oc3Model): Record<string, unknown> {
  if (model.endpoint !== "chat-completions") return body;
  const reasoning = body.reasoning;
  const effort = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>).effort
    : undefined;
  const next = { ...body };
  delete next.reasoning;
  if (typeof effort !== "string" || !effort) return next;
  const family = thinkingFamily(model.rawModelId, model.name);
  if (!family) {
    next.reasoning_effort = effort;
    return next;
  }
  Object.assign(next, reasoningWirePayload(family, model.rawModelId, model.endpoint, effort as never));
  return next;
}
