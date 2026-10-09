import { loadCatalogCache, saveCatalogSection } from "./store";
import { fetchGatewayModels, freeConsoleModels } from "./gateway";
import { discoveryTokens } from "./credentials";
import { modelsFromConsoleConfig, nativeChatGptModels, nativeOpenAiModels, sortModelsByGroup, type Oc3Model } from "./models";
import type { OpenCodeAuth } from "./auth";

export async function loadConsoleModels(auth: OpenCodeAuth): Promise<Oc3Model[]> {
  const { token, server, orgId } = await auth.getCredential("console");
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
  if (auth.isSignedIn("console")) {
    try {
      consoleModels = await loadConsoleModels(auth);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  // Gateway discovery carries the credential of each slot — the same
  // key > slot-session precedence as request routing, in one place.
  const discovery = await discoveryTokens(auth);
  for (const message of discovery.errors) if (!errors.includes(message)) errors.push(message);
  const refreshed = await refreshGatewayCatalogs({
    skipConsole: auth.isSignedIn("console"),
    consoleToken: discovery.consoleToken,
    goToken: discovery.goToken,
  });
  for (const message of refreshed.errors) if (!errors.includes(message)) errors.push(message);
  // A signed-in session replaces the public Console discovery with the org
  // catalog; on org fetch failure the cached section keeps serving.
  const cache = loadCatalogCache();
  const consoleList = consoleModels.length ? consoleModels : cache.console as Oc3Model[];
  const models = sortModelsByGroup([
    ...consoleList,
    ...refreshed.go,
    ...nativeChatGptModels(),
    ...(process.env.OPENAI_API_KEY ? nativeOpenAiModels() : []),
  ]);
  return { models, errors };
}

/**
 * Public gateway discovery (Console /models + Go /models). A token (service
 * key or the shared Console session) rides along as Bearer. When a Console
 * session provides the org-scoped catalog, the public Console list is
 * superseded and skipped; Go discovery is always public and unfiltered.
 */
export async function refreshGatewayCatalogs(options: { skipConsole?: boolean; consoleToken?: string; goToken?: string } = {}): Promise<{ console: Oc3Model[]; go: Oc3Model[]; errors: string[] }> {
  const errors: string[] = [];
  const [console, go] = await Promise.all([
    options.skipConsole ? Promise.resolve(undefined) : fetchGatewayModels("console", options.consoleToken),
    fetchGatewayModels("go", options.goToken),
  ]);
  // Anonymous Console discovery mirrors upstream: paid models stay hidden.
  const consoleModels = console && !options.consoleToken ? freeConsoleModels(console) : console;
  if (consoleModels) saveCatalogSection("console", consoleModels);
  else if (!options.skipConsole) errors.push("Console catalog unreachable; keeping cached models");
  if (go) saveCatalogSection("go", go);
  else errors.push("Go catalog unreachable; keeping cached models");
  return { console: consoleModels ?? [], go: go ?? [], errors };
}
