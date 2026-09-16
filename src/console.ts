import { modelsFromConsoleConfig, nativeChatGptModels, nativeOpenAiModels, sortModelsByGroup, type Oc3Model } from "./models";
import { loadCatalogCache, saveCatalogSection } from "./store";
import { fetchGatewayModels } from "./zen";
import type { OpenCodeAuth } from "./auth";

export async function loadConsoleModels(auth: OpenCodeAuth): Promise<Oc3Model[]> {
  const { token, server, orgId } = await auth.getCredential();
  if (!orgId) throw new Error("No organization selected. Run: oc3 org");
  const serverBase = server.replace(/\/+$/, "");
  const response = await fetch(`${serverBase}/api/config`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "x-org-id": orgId },
  });
  if (response.status === 404) throw new Error("This OpenCode Console server does not expose organization configuration");
  if (!response.ok) throw new Error(`OpenCode Console model configuration failed (${response.status})`);
  const payload = await response.json() as unknown;
  const models = modelsFromConsoleConfig(payload);
  if (!models.length) throw new Error("OpenCode Console returned no usable models");
  saveCatalogSection("console", models);
  return models;
}

export function availableModels(): Oc3Model[] {
  const cache = loadCatalogCache();
  const chatGpt = nativeChatGptModels();
  const openAi = process.env.OPENAI_API_KEY ? nativeOpenAiModels() : [];
  return sortModelsByGroup([
    ...cache.console as Oc3Model[],
    ...cache.zen as Oc3Model[],
    ...cache.go as Oc3Model[],
    ...chatGpt,
    ...openAi,
  ]);
}

export interface RefreshResult {
  models: Oc3Model[];
  errors: string[];
}

export async function refreshModels(auth: OpenCodeAuth): Promise<RefreshResult> {
  const errors: string[] = [];
  let consoleModels: Oc3Model[] = [];
  if (auth.isSignedIn()) {
    try {
      consoleModels = await loadConsoleModels(auth);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const refreshed = await refreshGatewayCatalogs();
  errors.push(...refreshed.errors);
  const models = sortModelsByGroup([
    ...consoleModels,
    ...refreshed.zen,
    ...refreshed.go,
    ...nativeChatGptModels(),
    ...(process.env.OPENAI_API_KEY ? nativeOpenAiModels() : []),
  ]);
  return { models, errors };
}

export async function refreshGatewayCatalogs(): Promise<{ zen: Oc3Model[]; go: Oc3Model[]; errors: string[] }> {
  const errors: string[] = [];
  const [zen, go] = await Promise.all([fetchGatewayModels("zen"), fetchGatewayModels("go")]);
  if (zen) saveCatalogSection("zen", zen);
  else errors.push("Zen catalog unreachable; keeping cached models");
  if (go) saveCatalogSection("go", go);
  else errors.push("Go catalog unreachable; keeping cached models");
  return { zen: zen ?? [], go: go ?? [], errors };
}
