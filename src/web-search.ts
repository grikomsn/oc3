// Web search bridge: Codex clients send hosted `web_search` tool declarations;
// chat-completions models cannot execute them natively. OpenCode itself calls
// Exa/Parallel MCP servers client-side (packages/opencode/src/tool/websearch.ts,
// mcp-websearch.ts) — oc3 mirrors that contract here.

import type { Oc3Model } from "./models";

export interface WebSearchResult {
  ok: boolean;
  text: string;
  provider: string;
}

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

function mcpUrl(provider: "exa" | "parallel"): string {
  if (provider === "exa") return process.env.OC3_EXA_MCP_URL ?? EXA_MCP_URL;
  return process.env.OC3_PARALLEL_MCP_URL ?? PARALLEL_MCP_URL;
}
const SEARCH_TIMEOUT_MS = 25_000;

export function searchBridgeNeeded(body: Record<string, unknown>, model: Oc3Model): boolean {
  if (model.endpoint !== "chat-completions") return false;
  const tools = body.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    const type = (tool as Record<string, unknown> | undefined)?.type;
    return type === "web_search" || type === "web_search_preview";
  });
}

export function stripHostedSearchTool(body: Record<string, unknown>): { body: Record<string, unknown>; changed: boolean } {
  const tools = body.tools;
  if (!Array.isArray(tools)) return { body, changed: false };
  let changed = false;
  const next = tools.filter((tool) => {
    const type = (tool as Record<string, unknown> | undefined)?.type;
    if (type === "web_search" || type === "web_search_preview") {
      changed = true;
      return false;
    }
    return true;
  });
  if (!changed) return { body, changed };
  return { body: { ...body, tools: [...next, {
    type: "function",
    name: "web_search",
    description: "Search the web. Returns extracted page content for the query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
  }] }, changed };
}

export function selectSearchProvider(sessionId: string): "exa" | "parallel" {
  const override = process.env.OC3_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "parallel") return override;
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? "exa" : "parallel";
}

export async function executeWebSearch(query: string, sessionId: string): Promise<string> {
  const provider = selectSearchProvider(sessionId);
  const url = mcpUrl(provider);
  const toolName = provider === "parallel" ? "web_search" : "web_search_exa";
  const args = provider === "parallel"
    ? { objective: query, search_queries: [query], session_id: sessionId }
    : { query, type: "auto", numResults: 8, livecrawl: "fallback", contextMaxCharacters: 10000 };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "oc3/0.1.0",
  };
  if (provider === "parallel" && process.env.PARALLEL_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PARALLEL_API_KEY}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return `web search failed (${response.status})`;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  let payload: unknown;
  if (contentType.includes("text/event-stream")) {
    let text = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const value = JSON.parse(payload) as Record<string, unknown>;
        const extracted = extractMcpText(value);
        if (extracted) { text = extracted; break; }
      } catch { /* skip malformed lines */ }
    }
    return text || `web search returned no results for: ${query}`;
  }
  try {
    const value = JSON.parse(raw);
    return extractMcpText(value) ?? `web search returned no results for: ${query}`;
  } catch {
    return `web search returned unparseable output for: ${query}`;
  }

  function extractMcpText(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const result = (value as Record<string, unknown>).result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return undefined;
    for (const part of content) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
        && typeof (part as Record<string, unknown>).text === "string"
        && ((part as Record<string, unknown>).text as string).trim()) {
        return (part as Record<string, unknown>).text as string;
      }
    }
    return undefined;
  }
}

function toolName(name: string | undefined): string {
  return name ?? "web_search_exa";
}
