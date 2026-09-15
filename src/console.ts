import { modelsFromConsoleConfig, nativeOpenAiModels, type Oc3Model } from "./models";
import { loadCachedModels, saveCachedModels } from "./store";
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
  saveCachedModels(models);
  return models;
}

export function availableModels(): Oc3Model[] {
  const cached = loadCachedModels<Oc3Model>();
  const openAi = process.env.OPENAI_API_KEY ? nativeOpenAiModels() : [];
  return [...cached, ...openAi];
}

export async function refreshModels(auth: OpenCodeAuth): Promise<Oc3Model[]> {
  const consoleModels = await loadConsoleModels(auth);
  const openAi = process.env.OPENAI_API_KEY ? nativeOpenAiModels() : [];
  return [...consoleModels, ...openAi];
}
