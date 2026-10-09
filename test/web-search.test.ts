import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { searchBridgeNeeded, stripHostedSearchTool, selectSearchProvider, executeWebSearch } from "../src/web-search";
import type { Oc3Model } from "../src/models";

const chatModel: Oc3Model = {
  id: "acme/fast", rawModelId: "fast", providerId: "acme", name: "fast",
  contextLength: 128000, maxOutputTokens: 8192, reasoning: false, imageInput: false,
  toolCalling: true, endpoint: "chat-completions", baseUrl: "https://x.test/v1",
};
const responsesModel: Oc3Model = { ...chatModel, endpoint: "responses" };

describe("searchBridgeNeeded", () => {
  test("true only for chat models with a web_search declaration", () => {
    expect(searchBridgeNeeded({ tools: [{ type: "web_search" }] }, chatModel)).toBe(true);
    expect(searchBridgeNeeded({ tools: [{ type: "web_search_preview" }] }, chatModel)).toBe(true);
    expect(searchBridgeNeeded({ tools: [{ type: "web_search" }] }, responsesModel)).toBe(false);
    expect(searchBridgeNeeded({ tools: [{ type: "function", name: "x" }] }, chatModel)).toBe(false);
  });
});

describe("stripHostedSearchTool", () => {
  test("replaces hosted declarations with a web_search function tool", () => {
    const { body, changed } = stripHostedSearchTool({
      tools: [{ type: "web_search" }, { type: "function", name: "shell" }],
    });
    expect(changed).toBe(true);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.some((tool) => tool.type === "web_search")).toBe(false);
    const fn = tools.find((tool) => tool.name === "web_search")!;
    expect(fn.type).toBe("function");
    expect((fn.parameters as Record<string, unknown>).properties).toHaveProperty("query");
  });
});

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("selectSearchProvider", () => {
  test("honors the env override", async () => {
    await withEnv({ OC3_WEBSEARCH_PROVIDER: "parallel" }, async () => {
      expect(selectSearchProvider("anything")).toBe("parallel");
    });
  });

  test("splits sessions across both providers deterministically", async () => {
    await withEnv({ OC3_WEBSEARCH_PROVIDER: undefined }, async () => {
      const sessions = Array.from({ length: 16 }, (_, index) => `session-${index}`);
      const assigned = new Set(sessions.map((session) => selectSearchProvider(session)));
      expect([...assigned].sort()).toEqual(["exa", "parallel"]);
      expect(selectSearchProvider("session-3")).toBe(selectSearchProvider("session-3"));
    });
  });
});

let mcp: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/sse") {
        return new Response([
          "event: message",
          `data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}`,
          "",
          "event: message",
          `data: {"jsonrpc":"2.0","id":1,`,
          `data: "result":{"content":[{"type":"text","text":"sse hit"}]}}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (pathname === "/busy") return new Response("busy", { status: 503 });
      if (pathname === "/text") return new Response("not json", { headers: { "Content-Type": "application/json" } });
      if (pathname === "/slow") {
        await Bun.sleep(300);
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      }
      const payload = await request.json() as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      const query = payload.params.arguments.query ?? payload.params.arguments.objective ?? "";
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: payload.id,
        result: { content: [{ type: "text", text: `${pathname} ${payload.params.name}: ${query}` }] },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  base = `http://127.0.0.1:${mcp.port}`;
});

afterAll(() => mcp.stop(true));

describe("executeWebSearch", () => {
  test("calls the exa endpoint with the exa tool and extracts result text", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: `${base}/echo` }, () =>
      executeWebSearch("bun latest release", "sess1"));
    expect(result).toBe("/echo web_search_exa: bun latest release");
  });

  test("routes the parallel provider to its own endpoint and tool", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "parallel", OC3_PARALLEL_MCP_URL: `${base}/echo` }, () =>
      executeWebSearch("q", "sess1"));
    expect(result).toBe("/echo web_search: q");
  });

  test("joins multi-line SSE data events before parsing", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: `${base}/sse` }, () =>
      executeWebSearch("q", "sess1"));
    expect(result).toBe("sse hit");
  });

  test("reports non-2xx responses as tool output", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: `${base}/busy` }, () =>
      executeWebSearch("q", "sess1"));
    expect(result).toBe("web search failed: HTTP 503");
  });

  test("reports timeouts as tool output instead of throwing", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: `${base}/slow` }, () =>
      executeWebSearch("q", "sess1", 20));
    expect(result).toStartWith("web search failed: ");
    expect(result).toContain("timed out");
  });

  test("reports network failures as tool output instead of throwing", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${closed.port}/mcp`;
    closed.stop(true);
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: deadUrl }, () =>
      executeWebSearch("q", "sess1"));
    expect(result).toStartWith("web search failed: ");
  });

  test("reports unparseable JSON bodies", async () => {
    const result = await withEnv({ OC3_WEBSEARCH_PROVIDER: "exa", OC3_EXA_MCP_URL: `${base}/text` }, () =>
      executeWebSearch("q", "sess1"));
    expect(result).toBe("web search returned unparseable output for: q");
  });
});
