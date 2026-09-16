import { nativeChatGptBase, nativeOpenAiBase, resolveEndpointKind, type EndpointKind, type OpenCodeMode } from "./protocol";

export interface ModelSource {
  id?: string;
  name?: string;
  family?: string;
  limit?: { context?: number; input?: number; output?: number };
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[]; min?: number; max?: number }>;
  tool_call?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[] };
  status?: string;
  disabled?: boolean;
  provider?: { npm?: string; api?: string };
  options?: Record<string, unknown>;
  cost?: { input?: number; output?: number; context_over_200k?: number };
}

export interface ProviderSource {
  id?: string;
  name?: string;
  api?: string;
  npm?: string;
  models?: Record<string, ModelSource>;
  options?: Record<string, unknown>;
}

export interface Oc3Model {
  id: string;
  rawModelId: string;
  providerId: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  toolCalling: boolean;
  endpoint: EndpointKind;
  baseUrl: string;
  // Supported reasoning efforts from the catalog (models.dev reasoning_options);
  // undefined means the family defaults apply.
  reasoningEfforts?: string[];
  // USD per million tokens from the catalog, when published.
  cost?: { input?: number; output?: number; inputOver200k?: number };
  // Which catalog produced this entry; gateway ids may also appear in the
  // Console org config, where the Console session token is the credential.
  source?: "console" | "gateway";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export function apiBaseForMode(mode: OpenCodeMode): string {
  if (mode === "go") return "https://opencode.ai/zen/go/v1";
  return "https://opencode.ai/zen/v1";
}

export function modelsFromProvider(providerId: string, provider: ProviderSource): Oc3Model[] {
  const sources = provider.models ?? {};
  return Object.entries(sources).flatMap(([rawId, source]) => {
    if (source.status === "deprecated" || source.disabled === true) return [];
    const packageName = source.provider?.npm ?? provider.npm;
    const baseUrl = source.provider?.api ?? provider.api ?? apiBaseForMode("zen");
    const modelId = source.id ?? rawId;
    const contextLength = positive(source.limit?.context, 32768);
    return [{
      id: rawId,
      rawModelId: modelId,
      providerId,
      name: source.name ?? prettifyModelName(modelId),
      contextLength,
      maxOutputTokens: positive(source.limit?.output, Math.min(contextLength, 8192)),
      reasoning: source.reasoning === true,
      imageInput: Array.isArray(source.modalities?.input) ? source.modalities.input.includes("image") : source.attachment === true,
      toolCalling: source.tool_call === true,
      endpoint: resolveEndpointKind(modelId, "console", packageName),
      baseUrl,
      source: "console",
      ...spreadMetadata(source),
      ...(provider.options && isStringRecord(provider.options.headers) ? { headers: provider.options.headers } : {}),
      ...(provider.options ? { body: withoutCredentials(provider.options) } : {}),
    }];
  });
}

// Gateway (Zen / Go) provider entry from the models.dev-style catalog.
// Diffs from the console path: ids are always namespaced by provider, the
// endpoint kind resolves with the gateway mode, and the baseUrl defaults to
// the mode's gateway root instead of the console default.
export function modelsFromGatewayProvider(providerId: string, provider: ProviderSource, mode: "zen" | "go"): Oc3Model[] {
  const sources = provider.models ?? {};
  return Object.entries(sources).flatMap(([rawId, source]) => {
    if (source.status === "deprecated" || source.disabled === true) return [];
    const packageName = source.provider?.npm ?? provider.npm;
    const baseUrl = source.provider?.api ?? provider.api ?? apiBaseForMode(mode);
    const modelId = source.id ?? rawId;
    const contextLength = positive(source.limit?.context, 32_768);
    return [{
      id: `${providerId}/${rawId}`,
      rawModelId: modelId,
      providerId,
      name: source.name ?? rawId,
      contextLength,
      maxOutputTokens: positive(source.limit?.output, Math.min(contextLength, 8192)),
      reasoning: source.reasoning === true,
      imageInput: Array.isArray(source.modalities?.input) ? source.modalities.input.includes("image") : source.attachment === true,
      toolCalling: source.tool_call === true,
      endpoint: resolveEndpointKind(modelId, mode, packageName),
      baseUrl,
      source: "gateway",
      ...spreadMetadata(source),
      ...(provider.options && isStringRecord(provider.options.headers) ? { headers: provider.options.headers } : {}),
      ...(provider.options ? { body: withoutCredentials(provider.options) } : {}),
    }];
  });
}

// Minimal model for a gateway /models entry with no models.dev metadata.
export function minimalGatewayModel(providerId: string, mode: "zen" | "go", rawModelId: string): Oc3Model {
  return {
    id: `${providerId}/${rawModelId}`,
    rawModelId,
    providerId,
    name: prettifyModelName(rawModelId),
    contextLength: 128_000,
    maxOutputTokens: 32_768,
    reasoning: false,
    imageInput: false,
    toolCalling: true,
    endpoint: resolveEndpointKind(rawModelId, mode),
    baseUrl: apiBaseForMode(mode),
    source: "gateway",
  };
}

function spreadMetadata(source: ModelSource): Partial<Oc3Model> {
  return {
    ...(reasoningEffortsFromSource(source) ? { reasoningEfforts: reasoningEffortsFromSource(source) } : {}),
    ...(costFromSource(source) ? { cost: costFromSource(source) } : {}),
  };
}

export function modelsFromConsoleConfig(payload: unknown): Oc3Model[] {
  const providers = asRecord(asRecord(payload)?.config)?.provider ?? {};
  const entries: Oc3Model[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    entries.push(...modelsFromProvider(id, provider as ProviderSource));
  }
  const counts = new Map<string, number>();
  for (const model of entries) counts.set(model.rawModelId, (counts.get(model.rawModelId) ?? 0) + 1);
  return entries.map((model) =>
    (counts.get(model.rawModelId) ?? 0) > 1 ? { ...model, id: `${model.providerId}/${model.rawModelId}` } : model,
  );
}

export function nativeOpenAiModels(): Oc3Model[] {
  const models: Oc3Model[] = [];
  const extra = (process.env.OC3_OPENAI_MODELS ?? "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna")
    .split(",").map((value) => value.trim()).filter(Boolean);
  for (const id of extra) {
    models.push({
      id: `openai/${id}`,
      rawModelId: id,
      providerId: "openai",
      name: prettifyModelName(id),
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      imageInput: true,
      toolCalling: true,
      endpoint: resolveEndpointKind(id, "zen", "@ai-sdk/openai"),
      baseUrl: process.env.OC3_OPENAI_BASE_URL ?? nativeOpenAiBase(),
    });
  }
  return models;
}

const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Catalog reasoning_options -> canonical effort list (unknown values ignored). */
export function reasoningEffortsFromSource(source: ModelSource): string[] | undefined {
  const options = Array.isArray(source.reasoning_options) ? source.reasoning_options : [];
  const found = new Set<string>();
  for (const option of options) {
    const values = option && Array.isArray(option.values) ? option.values : [];
    for (const value of values) {
      if (typeof value === "string" && KNOWN_EFFORTS.includes(value.toLowerCase())) {
        found.add(value.toLowerCase());
      }
    }
  }
  if (!found.size) return undefined;
  return [...found].sort((a, b) => KNOWN_EFFORTS.indexOf(a) - KNOWN_EFFORTS.indexOf(b));
}

function costFromSource(source: ModelSource): Oc3Model["cost"] {
  const cost = source.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const result: Oc3Model["cost"] = {};
  if (typeof cost.input === "number") result.input = cost.input;
  if (typeof cost.output === "number") result.output = cost.output;
  if (typeof cost.context_over_200k === "number") result.inputOver200k = cost.context_over_200k;
  return Object.keys(result).length ? result : undefined;
}

// Display metadata -----------------------------------------------------------

const NAME_TOKENS: Array<[string, string]> = [
  ["minimax", "MiniMax"],
  ["deepseek", "DeepSeek"],
  ["grok", "Grok"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["qwen", "Qwen"],
  ["kimi", "Kimi"],
  ["glm", "GLM"],
  ["gpt", "GPT"],
  ["mimo", "MiMo"],
  ["llm", "LLM"],
  ["api", "API"],
  ["hy", "Hybrid"],
];

/** Raw model ids like "gpt-5.6-sol" become display names like "GPT 5.6 Sol". */
export function prettifyModelName(rawId: string): string {
  return rawId.split(/[-_\s]+/).filter(Boolean).map((token) => {
    const lower = token.toLowerCase();
    for (const [prefix, canonical] of NAME_TOKENS) {
      if (lower === prefix || lower.startsWith(prefix)) return canonical + token.slice(prefix.length);
    }
    if (/^[a-z]+\d/i.test(token)) return token.charAt(0).toUpperCase() + token.slice(1);
    if (/^\d/.test(token)) return token;
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(" ");
}

export type ModelGroup = "console" | "zen" | "go" | "chatgpt" | "openai" | "other";

/** Which backend family a model belongs to, used for ordering and labels. */
export function modelGroup(model: Oc3Model): ModelGroup {
  if (model.providerId === "openai") return "openai";
  if (model.providerId === "chatgpt") return "chatgpt";
  if (model.source === "gateway") return model.providerId === "opencode-go" ? "go" : "zen";
  if (model.source === "console" || model.source === undefined) return "console";
  return "other";
}

const GROUP_ORDER: ReadonlyArray<ModelGroup> = ["console", "zen", "go", "chatgpt", "openai", "other"];

/** Stable backend-family ordering: Console, Zen, Go, native ChatGPT, native OpenAI. */
export function sortModelsByGroup(models: readonly Oc3Model[]): Oc3Model[] {
  const rank = (model: Oc3Model): number => Math.max(0, GROUP_ORDER.indexOf(modelGroup(model)));
  return [...models].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** Human label for a model's backend family. */
export function providerLabel(model: Oc3Model): string {
  switch (modelGroup(model)) {
    case "openai": return "OpenAI (native)";
    case "chatgpt": return "ChatGPT (native)";
    case "zen": return "OpenCode Zen";
    case "go": return "OpenCode Go";
    case "console": return "OpenCode Console";
    default: return model.providerId;
  }
}

export function nativeChatGptModels(): Oc3Model[] {
  const list = (process.env.OC3_CHATGPT_MODELS ?? "gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return list.map((id) => ({
    id: `chatgpt/${id}`,
    rawModelId: id,
    providerId: "chatgpt",
    name: prettifyModelName(id),
    contextLength: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    imageInput: true,
    toolCalling: true,
    endpoint: "responses" as EndpointKind,
    baseUrl: nativeChatGptBase(),
  }));
}

export function modelKey(slug: string): string {
  return slug.trim().toLowerCase().replace(/\[.*\]$/, "");
}

export function findModel(models: readonly Oc3Model[], requested: string): Oc3Model | undefined {
  const key = modelKey(requested);
  return models.find((model) => modelKey(model.id) === key)
    ?? models.find((model) => modelKey(model.rawModelId) === key)
    ?? models.find((model) => modelKey(model.id) === modelKey(`openai/${key}`));
}

function withoutCredentials(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "apiKey" && key !== "headers" && key !== "api_key" && key !== "baseUrl" && key !== "api"));
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
