// OpenCode gateway (Zen / Go) support: catalog discovery, credential routing
// and wire parity for the first-party opencode / opencode-go providers.
// References: sst/opencode packages/core/src/models-dev.ts, packages/core/src/
// plugin/provider/opencode.ts, console app routes zen/v1 + zen/go/v1.

import {
  apiBaseForMode,
  minimalGatewayModel,
  modelsFromGatewayProvider,
  type Oc3Model,
  type ProviderSource,
} from "./models";

export const ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export const GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";
export const GATEWAY_PROVIDER_IDS = { zen: "opencode", go: "opencode-go" } as const;
export const GATEWAY_MODELS_CATALOG_URL = "https://models.opencode.ai/api.json";

export type GatewayMode = "zen" | "go";

export function gatewayProviderId(mode: GatewayMode): string {
  return GATEWAY_PROVIDER_IDS[mode];
}

export function gatewayBaseUrl(mode: GatewayMode): string {
  const override = mode === "go" ? process.env.OC3_GO_BASE_URL : process.env.OC3_ZEN_BASE_URL;
  return (override ?? apiBaseForMode(mode)).replace(/\/+$/, "");
}

function gatewayCatalogUrl(): string {
  return (process.env.OC3_GATEWAY_CATALOG_URL ?? GATEWAY_MODELS_CATALOG_URL).replace(/\/+$/, "");
}

/** The gateway key that authorizes one provider's requests. */
export function gatewayKeyFor(providerId: string, keys: { zen?: string; go?: string }, envKey?: string): string {
  const env = envKey ?? process.env.OPENCODE_API_KEY;
  if (providerId === "opencode-go") return keys.go ?? keys.zen ?? env ?? "";
  return keys.zen ?? keys.go ?? env ?? "";
}

/**
 * Fetch and build the model catalog for one gateway mode. The live
 * `GET {base}/models` list is authoritative (it honors workspace-disabled
 * models); the models.dev snapshot only enriches metadata. Returns undefined
 * when the live list is unreachable so callers can keep the stale cache.
 */
export async function fetchGatewayModels(mode: GatewayMode): Promise<Oc3Model[] | undefined> {
  const baseUrl = gatewayBaseUrl(mode);
  const providerId = gatewayProviderId(mode);
  const liveIds = await fetchLiveModelIds(baseUrl, providerId);
  if (!liveIds) return undefined;
  const byRaw = new Map<string, Oc3Model>();
  const catalogProvider = await loadGatewayCatalogProvider(providerId);
  if (catalogProvider) {
    for (const model of modelsFromGatewayProvider(providerId, catalogProvider, mode)) {
      byRaw.set(model.rawModelId, model);
    }
  }
  const prefix = `${providerId}/`;
  return liveIds.map((raw) => {
    const bare = raw.startsWith(`${prefix}`) ? raw.slice(prefix.length) : raw;
    return byRaw.get(bare) ?? minimalGatewayModel(providerId, mode, bare);
  });
}

async function fetchLiveModelIds(baseUrl: string, providerId: string): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as unknown;
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : undefined;
    if (!Array.isArray(data)) return undefined;
    const prefix = `${providerId}/`;
    return data.flatMap((entry) => {
      const id = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).id
        : undefined;
      return typeof id === "string" && id ? [id.startsWith(prefix) ? id.slice(prefix.length) : id] : [];
    });
  } catch {
    return undefined;
  }
}

async function loadGatewayCatalogProvider(providerId: string): Promise<ProviderSource | undefined> {
  try {
    const response = await fetch(gatewayCatalogUrl(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as unknown;
    const providers = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).providers
      : undefined;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
    const entry = (providers as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return entry as ProviderSource;
  } catch {
    return undefined;
  }
}

/**
 * Responses wire extras opencode applies to its own gateway providers
 * (sst/opencode packages/opencode/src/provider/transform.ts): session-keyed
 * prompt caching, encrypted reasoning passthrough, and automatic summaries.
 */
export function gatewayResponsesExtras(body: Readonly<Record<string, unknown>>, sessionId: string): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    prompt_cache_key: sessionId,
    include: mergeInclude(body.include),
  };
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const record = reasoning as Record<string, unknown>;
    if (typeof record.summary !== "string") extras.reasoning = { ...record, summary: "auto" };
  }
  return extras;
}

function mergeInclude(existing: unknown): string[] {
  const base = Array.isArray(existing) ? existing.filter((item) => typeof item === "string") as string[] : [];
  return base.includes("reasoning.encrypted_content") ? base : [...base, "reasoning.encrypted_content"];
}

/**
 * chat_template_args opencode injects for thinking-mode community models.
 * Narrow allowlist so unrelated models never receive unexpected fields.
 */
export function gatewayChatTemplateArgs(model: Oc3Model): Record<string, unknown> | undefined {
  if (!model.providerId.startsWith("opencode")) return undefined;
  const id = model.rawModelId.toLowerCase();
  if (/^kimi-k2-thinking/.test(id) || /^glm-4\.6/.test(id)) {
    return { chat_template_args: { enable_thinking: true } };
  }
  return undefined;
}

/** Go subscription quota from the gateway's lite-tier usage endpoint. */
export async function fetchGatewayUsage(goKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${GO_API_BASE_URL}/usage`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${goKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenCode Go usage request failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}
