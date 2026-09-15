// Ollama-Desktop-style routing catalog: per-model thinking metadata the Codex
// desktop app reads (~/.codex/ollama-launch-codex-routing.json in Ollama's
// case) and the proxy uses to normalize reasoning.effort per model.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Oc3Model } from "./models";
import { ensureHome, oc3Home } from "./store";
import { thinkingFamily } from "./reasoning";

export interface ThinkingMetadata {
  supported: boolean;
  levels: string[];
  values?: Record<string, unknown>;
}

export interface RoutingModel {
  slug: string;
  thinking?: ThinkingMetadata;
}

export interface RoutingCatalog {
  models: RoutingModel[];
  auto_review_model?: string;
  auto_review_fallback_model?: string;
}

const FAMILY_LEVELS: Record<string, string[]> = {
  openai: ["none", "low", "medium", "high"],
  deepseek: ["low", "high"],
  glm: ["low", "high", "max"],
  kimi: ["none", "low", "high", "max"],
  minimax: ["medium"],
  mimo: ["low", "medium", "high"],
  qwen: ["none", "low", "medium", "high"],
};

export function thinkingMetadataFor(model: Oc3Model): ThinkingMetadata | undefined {
  if (!model.reasoning) return undefined;
  const family = thinkingFamily(model.rawModelId, model.name);
  if (!family) return undefined;
  const levels = FAMILY_LEVELS[family] ?? ["low", "medium", "high"];
  const values: Record<string, unknown> = {};
  if (family === "qwen" || family === "kimi") values["none"] = false;
  return { supported: true, levels, values: Object.keys(values).length ? values : undefined };
}

export function writeRoutingCatalog(models: readonly Oc3Model[], path?: string): string {
  const catalog: RoutingCatalog = {
    models: models.map((model) => {
      const entry: RoutingModel = { slug: model.id };
      const thinking = thinkingMetadataFor(model);
      if (thinking) entry.thinking = thinking;
      return entry;
    }),
  };
  ensureHome();
  const target = routingCatalogPath(path);
  writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
  return target;
}

export function routingCatalogPath(explicit?: string): string {
  if (explicit) return explicit;
  return join(oc3Home(), "codex-routing.json");
}

// --- reasoning effort normalization against thinking metadata ---

export function normalizeReasoningEffort(
  effort: string | undefined,
  thinking: ThinkingMetadata | undefined,
): string | undefined {
  if (!effort) return undefined;
  let normalized: string;
  switch (effort) {
    case "minimal": normalized = "low"; break;
    case "xhigh":
    case "ultra": normalized = "max"; break;
    case "none":
    case "low":
    case "medium":
    case "high":
    case "max": normalized = effort; break;
    default: return undefined;
  }
  const levels = thinking?.levels;
  if (!levels || !levels.length) return normalized;
  if (levels.length === 2 && levels.includes("none") && levels.includes("medium")) {
    return normalized === "none" ? "none" : "medium";
  }
  if (levels.includes(normalized)) return normalized;
  if (normalized === "max" && levels.includes("high")) return "high";
  return undefined;
}
