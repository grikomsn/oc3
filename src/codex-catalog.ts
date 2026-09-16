import { ensureHome, codexCatalogPath } from "./store";
import { writeFileSync } from "node:fs";
import { writeRoutingCatalog } from "./routing-catalog";
import { providerLabel, type Oc3Model } from "./models";

const DEFAULT_REASONING_LEVELS = [
  { description: "Turn thinking off", effort: "none" },
  { description: "Fast responses with lighter thinking", effort: "low" },
  { description: "Balanced responses with regular thinking", effort: "medium" },
  { description: "Thorough responses with deeper thinking", effort: "high" },
  { description: "Exhaustive responses with maximum thinking", effort: "xhigh" },
];

const FALLBACK_BASE_INSTRUCTIONS = "You are a helpful coding agent. Complete the user's task using the provided tools.";

export async function readDefaultBaseInstructions(): Promise<string> {
  const path = `${process.env.HOME}/.codex/ollama-launch-models.json`;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return FALLBACK_BASE_INSTRUCTIONS;
    const parsed = JSON.parse(await file.text()) as { models?: Array<{ base_instructions?: string }> };
    const instructions = parsed.models?.[0]?.base_instructions;
    return typeof instructions === "string" && instructions.trim() ? instructions : FALLBACK_BASE_INSTRUCTIONS;
  } catch {
    return FALLBACK_BASE_INSTRUCTIONS;
  }
}

export async function writeCodexCatalog(models: readonly Oc3Model[]): Promise<void> {
  const baseInstructions = await readDefaultBaseInstructions();
  const catalog = {
    models: models.map((model, index) => ({
      additional_speed_tiers: [],
      apply_patch_tool_type: null,
      auto_compact_token_limit: null,
      availability_nux: null,
      base_instructions: baseInstructions,
      context_window: model.contextLength,
      default_reasoning_level: model.reasoning ? "medium" : "none",
      default_reasoning_summary: "auto",
      default_service_tier: null,
      default_verbosity: null,
      description: `${model.name} — ${providerLabel(model)}`,
      display_name: model.name,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      include_apps_usage_instructions: true,
      include_plugin_usage_instructions: true,
      include_skills_usage_instructions: true,
      input_modalities: model.imageInput ? ["text", "image"] : ["text"],
      max_context_window: model.contextLength,
      model_messages: null,
      priority: -4 + index,
      service_tiers: [],
      shell_type: "unified_exec",
      slug: model.id,
      support_verbosity: false,
      supported_in_api: true,
      supported_reasoning_levels: model.reasoning ? DEFAULT_REASONING_LEVELS : DEFAULT_REASONING_LEVELS.slice(0, 1),
      supports_image_detail_original: false,
      supports_parallel_tool_calls: model.toolCalling,
      supports_reasoning_summaries: false,
      supports_reasoning_summary_parameter: false,
      supports_search_tool: true,
      truncation_policy: { limit: 10000, mode: "tokens" },
      upgrade: null,
      visibility: "list",
      web_search_tool_type: "text",
    })),
  };
  ensureHome();
  writeFileSync(codexCatalogPath(), `${JSON.stringify(catalog, null, 2)}\n`);
  writeRoutingCatalog(models);
}
