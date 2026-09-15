import { afterAll, describe, expect, test } from "bun:test";
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

describe("selectSearchProvider", () => {
  test("honors env override and splits sessions", () => {
    process.env.OC3_WEBSEARCH_PROVIDER = "parallel";
    expect(selectSearchProvider("anything")).toBe("parallel");
    delete process.env.OC3_WEBSEARCH_PROVIDER;
    expect(["exa", "parallel"]).toContain(selectSearchProvider("s1"));
  });
});

const MCP_PORT = 8977;
const mcpServer = Bun.serve({
  hostname: "127.0.0.1",
  port: MCP_PORT,
  async fetch(request) {
    const payload = await request.json() as Record<string, unknown>;
    const params = payload.params as Record<string, unknown>;
    const args = params.arguments as Record<string, unknown>;
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: payload.id,
      result: { content: [{ type: "text", text: `results for: ${args.query ?? args.objective ?? ""}` }] },
    }), { headers: { "Content-Type": "application/json" } });
  },
});

afterAll(() => mcpServer.stop(true));

describe("executeWebSearch", () => {
  test("calls the MCP endpoint and extracts result text", async () => {
    process.env.OC3_EXA_MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
    process.env.OC3_WEBSEARCH_PROVIDER = "exa";
    try {
      const result = await executeWebSearch("bun latest release", "sess1");
      expect(result).toBe("results for: bun latest release");
    } finally {
      delete process.env.OC3_EXA_MCP_URL;
      delete process.env.OC3_WEBSEARCH_PROVIDER;
    }
  });
});
