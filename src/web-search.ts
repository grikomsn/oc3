// Web search bridge: Codex clients send hosted `web_search` tool declarations;
// chat-completions models cannot execute them natively. OpenCode itself calls
// Exa/Parallel MCP servers client-side (packages/opencode/src/tool/websearch.ts,
// mcp-websearch.ts) — oc3 mirrors that contract here.

import type { Oc3Model } from "./models";
import { userAgent } from "./protocol";
import { SseParser } from "./sse-parser";

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

// Never throws: failures come back as tool output so one bad search does not fail the turn.
export async function executeWebSearch(query: string, sessionId: string, timeoutMs = SEARCH_TIMEOUT_MS): Promise<string> {
  const provider = selectSearchProvider(sessionId);
  const url = mcpUrl(provider);
  const toolName = provider === "parallel" ? "web_search" : "web_search_exa";
  const args = provider === "parallel"
    ? { objective: query, search_queries: [query], session_id: sessionId }
    : { query, type: "auto", numResults: 8, livecrawl: "fallback", contextMaxCharacters: 10000 };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": userAgent(),
  };
  if (provider === "parallel" && process.env.PARALLEL_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PARALLEL_API_KEY}`;
  }
  let contentType: string;
  let raw: string;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return `web search failed: HTTP ${response.status}`;
    contentType = response.headers.get("content-type") ?? "";
    raw = await response.text();
  } catch (error) {
    return `web search failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (contentType.includes("text/event-stream")) {
    const parser = new SseParser();
    for (const block of [...parser.push(raw), ...parser.finish()]) {
      const text = mcpText(block.data);
      if (text) return text;
    }
    return `web search returned no results for: ${query}`;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return `web search returned unparseable output for: ${query}`;
  }
  return extractMcpText(value) ?? `web search returned no results for: ${query}`;
}

function mcpText(payload: string): string | undefined {
  try {
    return extractMcpText(JSON.parse(payload));
  } catch {
    return undefined;
  }
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
