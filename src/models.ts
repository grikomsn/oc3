import { OPENAI_API_BASE, resolveEndpointKind, type EndpointKind, type OpenCodeMode } from "./protocol";

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
      name: source.name ?? rawId,
      contextLength,
      maxOutputTokens: positive(source.limit?.output, Math.min(contextLength, 8192)),
      reasoning: source.reasoning === true,
      imageInput: Array.isArray(source.modalities?.input) ? source.modalities.input.includes("image") : source.attachment === true,
      toolCalling: source.tool_call === true,
      endpoint: resolveEndpointKind(modelId, "console", packageName),
      baseUrl,
      ...(provider.options && isStringRecord(provider.options.headers) ? { headers: provider.options.headers } : {}),
      ...(provider.options ? { body: provider.options } : {}),
    }];
  });
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
      name: id,
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      imageInput: true,
      toolCalling: true,
      endpoint: resolveEndpointKind(id, "zen", "@ai-sdk/openai"),
      baseUrl: OPENAI_API_BASE,
    });
  }
  return models;
}

export function findModel(models: readonly Oc3Model[], requested: string): Oc3Model | undefined {
  return models.find((model) => model.id === requested)
    ?? models.find((model) => model.rawModelId === requested)
    ?? models.find((model) => model.id === `openai/${requested}`);
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
