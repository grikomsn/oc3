import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { startServer } from "../src/server";
import { OpenCodeAuth } from "../src/auth";
import { clearKeys, loadKeys, loadCatalogCache, saveKeys, saveCatalogSection } from "../src/store";
import { modelsFromGatewayProvider, minimalGatewayModel, nativeChatGptModels, prettifyModelName, providerLabel, sortModelsByGroup, reasoningEffortsFromSource, type ProviderSource } from "../src/models";
import { writeCodexCatalog } from "../src/codex-catalog";
import { credentialForModel, credentialErrorHint } from "../src/credentials";
import { fetchGatewayModels, gatewayChatTemplateArgs, gatewayResponsesExtras } from "../src/zen";
import type { Oc3Model } from "../src/models";

const HOME = "/tmp/oc3-zen-test";
const PROXY_PORT = 8894;
const ZEN_PORT = 8901;
const GO_PORT = 8902;
const CATALOG_PORT = 8903;

const zenRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
const goRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

const zenUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: ZEN_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "opencode/gpt-model" }, { id: "opencode/gemini-flash" }] });
    }
    if (url.pathname.endsWith("/responses")) {
      zenRequests.push({ url: url.href, headers, body: await request.json() as Record<string, unknown> });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
          controller.enqueue(enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'));
          controller.enqueue(enc.encode('event: ping\ndata: {"type":"ping","cost":{"total":0.001}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

const goUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: GO_PORT,
  async fetch(request) {
    const headers = Object.fromEntries(request.headers.entries());
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "minimax-m3" }] });
    }
    if (pathname === "/v1/usage") {
      return Response.json({ usage: { rolling: { percent: 12 }, weekly: { percent: 4 }, monthly: { percent: 1 } } });
    }
    const body = await request.json() as Record<string, unknown>;
    goRequests.push({ url: new URL(request.url).href, headers, body });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[],"cost":{"total":0.0}}\n\n'));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

const catalogUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: CATALOG_PORT,
  async fetch(request) {
    if (new URL(request.url).pathname === "/api.json") {
      return Response.json({
        providers: {
          opencode: zenCatalogProvider,
          "opencode-go": goCatalogProvider,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const zenCatalogProvider: ProviderSource = {
  id: "opencode",
  name: "OpenCode Zen",
  api: `http://127.0.0.1:${ZEN_PORT}/v1`,
  npm: "@ai-sdk/openai-compatible",
  models: {
    "gpt-model": {
      id: "gpt-model",
      name: "GPT via Zen",
      reasoning: true,
      tool_call: true,
      attachment: true,
      limit: { context: 400000, output: 128000 },
      provider: { npm: "@ai-sdk/openai" },
      reasoning_options: [{ type: "string", values: ["low", "HIGH", "banana"] }],
      cost: { input: 1.5, output: 10, context_over_200k: 3 },
    },
    "gemini-flash": {
      name: "Gemini via Zen",
      reasoning: true,
      tool_call: true,
      limit: { context: 1000000, output: 64000 },
      provider: { npm: "@ai-sdk/google" },
    },
    "paid-model": { name: "Paid", status: "deprecated" },
  },
};

const goCatalogProvider: ProviderSource = {
  name: "OpenCode Go",
  npm: "@ai-sdk/openai-compatible",
  models: {
    "minimax-m3": { name: "MiniMax via Go", reasoning: true, tool_call: true, limit: { context: 200000, output: 32000 } },
  },
};

function gatewayModel(overrides: Partial<Oc3Model>): Oc3Model {
  return {
    id: "opencode/gpt-model",
    rawModelId: "gpt-model",
    providerId: "opencode",
    name: "GPT via Zen",
    contextLength: 400000,
    maxOutputTokens: 128000,
    reasoning: true,
    imageInput: true,
    toolCalling: true,
    endpoint: "responses",
    baseUrl: `http://127.0.0.1:${ZEN_PORT}/v1`,
    source: "gateway",
    ...overrides,
  };
}

async function postResponses(port: number, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const auth = new OpenCodeAuth();
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  setEnv("OC3_HOME", `${HOME}/.config/oc3`);
  mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
  setEnv("OC3_ZEN_BASE_URL", `http://127.0.0.1:${ZEN_PORT}/v1`);
  setEnv("OC3_GO_BASE_URL", `http://127.0.0.1:${GO_PORT}/v1`);
  setEnv("OC3_GATEWAY_CATALOG_URL", `http://127.0.0.1:${CATALOG_PORT}/api.json`);
  setEnv("OPENCODE_API_KEY", undefined);
  setEnv("OC3_TEST_TOKEN", undefined);
});

afterAll(() => {
  zenUpstream.stop(true);
  goUpstream.stop(true);
  catalogUpstream.stop(true);
  rmSync(HOME, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("gateway catalog parsing", () => {
  test("modelsFromGatewayProvider namespaces ids and resolves per-mode endpoints", () => {
    const zen = modelsFromGatewayProvider("opencode", zenCatalogProvider, "zen");
    const ids = zen.map((model) => model.id);
    expect(ids).toEqual(["opencode/gpt-model", "opencode/gemini-flash"]);
    expect(zen[0]!.endpoint).toBe("responses");
    expect(zen[0]!.baseUrl).toBe(`http://127.0.0.1:${ZEN_PORT}/v1`);
    expect(zen[0]!.imageInput).toBe(true);
    expect(zen[1]!.endpoint).toBe("google");
    expect(zen.map((model) => model.rawModelId)).not.toContain("paid-model");

    const go = modelsFromGatewayProvider("opencode-go", goCatalogProvider, "go");
    expect(go[0]!.id).toBe("opencode-go/minimax-m3");
    expect(go[0]!.endpoint).toBe("messages");
  });

  test("carries catalog reasoning efforts and cost metadata", () => {
    const zen = modelsFromGatewayProvider("opencode", zenCatalogProvider, "zen");
    const gpt = zen.find((model) => model.rawModelId === "gpt-model")!;
    expect(gpt.reasoningEfforts).toEqual(["low", "high"]);
    expect(gpt.cost).toEqual({ input: 1.5, output: 10, inputOver200k: 3 });
    const gemini = zen.find((model) => model.rawModelId === "gemini-flash")!;
    expect(gemini.reasoningEfforts).toBeUndefined();
    expect(gemini.cost).toBeUndefined();
  });

  test("reasoningEffortsFromSource ignores unknown values", () => {
    expect(reasoningEffortsFromSource({ reasoning_options: [{ values: ["nope", "banana", "high"] }] })).toEqual(["high"]);
    expect(reasoningEffortsFromSource({})).toBeUndefined();
  });

  test("codex catalog derives per-model reasoning levels and routing metadata", async () => {
    const zen = modelsFromGatewayProvider("opencode", zenCatalogProvider, "zen");
    await writeCodexCatalog(zen);
    const codex = JSON.parse(readFileSync(`${process.env.OC3_HOME}/codex-models.json`, "utf8")) as {
      models: Array<{ slug: string; supported_reasoning_levels: Array<{ effort: string }>; default_reasoning_level: string }>;
    };
    const gptEntry = codex.models.find((model) => model.slug === "opencode/gpt-model")!;
    expect(gptEntry.supported_reasoning_levels.map((level) => level.effort)).toEqual(["low", "high"]);
    expect(gptEntry.default_reasoning_level).toBe("low");
    const routing = JSON.parse(readFileSync(`${process.env.OC3_HOME}/codex-routing.json`, "utf8")) as {
      models: Array<{ slug: string; thinking?: { levels: string[] } }>;
    };
    const routingEntry = routing.models.find((model) => model.slug === "opencode/gpt-model")!;
    expect(routingEntry.thinking?.levels).toEqual(["low", "high"]);
  });

  test("minimalGatewayModel applies heuristic endpoint kinds", () => {
    const claude = minimalGatewayModel("opencode", "zen", "claude-sonnet-5");
    expect(claude.endpoint).toBe("messages");
    expect(claude.id).toBe("opencode/claude-sonnet-5");
    expect(claude.baseUrl).toContain("opencode.ai/zen/v1");
  });
});

describe("gateway wire parity", () => {
  test("gatewayResponsesExtras adds prompt cache key, encrypted reasoning include, auto summary", () => {
    const extras = gatewayResponsesExtras({ include: ["web_search_call"], reasoning: { effort: "high" } }, "sess_1");
    expect(extras.prompt_cache_key).toBe("sess_1");
    expect(extras.include).toEqual(["web_search_call", "reasoning.encrypted_content"]);
    expect(extras.reasoning).toEqual({ effort: "high", summary: "auto" });
    const withoutReasoning = gatewayResponsesExtras({}, "sess_2");
    expect("reasoning" in withoutReasoning).toBe(false);
  });

  test("gatewayResponsesExtras preserves an existing reasoning summary", () => {
    const extras = gatewayResponsesExtras({ reasoning: { effort: "low", summary: "concise" } }, "s");
    // the request's own reasoning object already carries a summary; no override
    expect("reasoning" in extras).toBe(false);
    expect(extras.prompt_cache_key).toBe("s");
  });

  test("gatewayChatTemplateArgs only targets thinking-mode community models", () => {
    const kimi = gatewayChatTemplateArgs(gatewayModel({ rawModelId: "kimi-k2-thinking" }));
    expect(kimi).toEqual({ chat_template_args: { enable_thinking: true } });
    const glm = gatewayChatTemplateArgs(gatewayModel({ rawModelId: "glm-4.6" }));
    expect(glm).toEqual({ chat_template_args: { enable_thinking: true } });
    expect(gatewayChatTemplateArgs(gatewayModel({ rawModelId: "glm-5.3-flash" }))).toBeUndefined();
    expect(gatewayChatTemplateArgs(gatewayModel({ providerId: "console", rawModelId: "kimi-k2-thinking" }))).toBeUndefined();
  });
});

describe("gateway credential routing", () => {
  test("prefers stored keys over the environment and falls back to public", async () => {
    saveKeys({ zen: "zen-key-123", go: "go-key-456" });
    setEnv("OPENCODE_API_KEY", "env-key");
    expect(await tokenFor(gatewayModel({ providerId: "opencode" }))).toBe("zen-key-123");
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("go-key-456");
    saveKeys({ zen: "zen-key-123" });
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("zen-key-123");
    clearKeys();
    expect(await tokenFor(gatewayModel({ providerId: "opencode" }))).toBe("env-key");
    setEnv("OPENCODE_API_KEY", undefined);
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("public");
  });

  test("OC3_TEST_TOKEN bypasses key resolution for gateway models", async () => {
    setEnv("OC3_TEST_TOKEN", "test-token");
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("test-token");
    setEnv("OC3_TEST_TOKEN", undefined);
  });

  test("console-origin opencode models keep the Console session credential", async () => {
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    writeSession("session-token");
    const consoleOrigin = await credentialForModel(gatewayModel({ source: "console" }), auth);
    expect(consoleOrigin?.token).toBe("session-token");
    expect(consoleOrigin?.orgId).toBe("org-1");
    expect(credentialErrorHint(gatewayModel({ source: "console" }))).toBe("Not signed in. Run: oc3 login");
    expect(credentialErrorHint(gatewayModel({ source: "gateway" }))).toContain("oc3 keys --set");
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });

  test("console and openai credentials keep their own hint messages", async () => {
    setEnv("OPENAI_API_KEY", undefined);
    const openAi = await credentialForModel(gatewayModel({ providerId: "openai" }), auth);
    expect(openAi).toBeUndefined();
    const consoleModel = gatewayModel({ providerId: "console-org", id: "console-org/model", baseUrl: "https://console.test" });
    expect(credentialErrorHint(consoleModel)).toBe("Not signed in. Run: oc3 login");
    expect(credentialErrorHint(gatewayModel({ providerId: "opencode-go" }))).toContain("oc3 keys --set");
  });
});

async function tokenFor(model: Oc3Model): Promise<string | undefined> {
  return (await credentialForModel(model, auth))?.token;
}

function writeSession(token: string, server = "https://opencode.ai/console"): void {
  writeFileSync(`${process.env.OC3_HOME}/session.json`, JSON.stringify({
    mode: "console",
    server,
    accessToken: token,
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
    accountId: "acct-1",
    email: "test@example.com",
    orgs: [{ id: "org-1", name: "Org" }],
    orgId: "org-1",
    orgName: "Org",
  }, null, 2));
}

describe("keys store", () => {
  test("persists 0600 keys.json in OC3_HOME", () => {
    saveKeys({ zen: "secret-zen-key" });
    const path = `${process.env.OC3_HOME}/keys.json`;
    expect(existsSync(path)).toBe(true);
    expect(loadKeys().zen).toBe("secret-zen-key");
    chmodSync(path, 0o644);
    saveKeys({ zen: "secret-zen-key" });
    expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("undefined");
    clearKeys();
    expect(loadKeys()).toEqual({});
  });
});

describe("gateway catalog fetch", () => {
  test("merges live /models with models.dev enrichment", async () => {
    const models = await fetchGatewayModels("zen");
    expect(models).toBeDefined();
    const gpt = models!.find((model) => model.rawModelId === "gpt-model");
    expect(gpt?.contextLength).toBe(400000);
    expect(gpt?.baseUrl).toBe(`http://127.0.0.1:${ZEN_PORT}/v1`);
    // live list is authoritative: catalog-only entries are dropped
    expect(models!.find((model) => model.rawModelId === "paid-model")).toBeUndefined();
    const goModels = await fetchGatewayModels("go");
    const minimax = goModels!.find((model) => model.rawModelId === "minimax-m3");
    expect(minimax?.baseUrl).toContain("/zen/go/v1");
    expect(minimax?.endpoint).toBe("messages");
  });

  test("returns undefined when the live catalog is unreachable", async () => {
    setEnv("OC3_ZEN_BASE_URL", "http://127.0.0.1:59999/v1");
    expect(await fetchGatewayModels("zen")).toBeUndefined();
    setEnv("OC3_ZEN_BASE_URL", `http://127.0.0.1:${ZEN_PORT}/v1`);
  });

  test("refresh keeps the cached section when the gateway is down", async () => {
    saveCatalogSection("zen", [gatewayModel({})]);
    setEnv("OC3_ZEN_BASE_URL", "http://127.0.0.1:59999/v1");
    const { refreshGatewayCatalogs } = await import("../src/console");
    const result = await refreshGatewayCatalogs();
    expect(result.errors.some((message) => message.includes("Zen catalog unreachable"))).toBe(true);
    expect(loadCatalogCache().zen).toHaveLength(1);
    setEnv("OC3_ZEN_BASE_URL", `http://127.0.0.1:${ZEN_PORT}/v1`);
  });
});

describe("model metadata", () => {
  test("prettifies raw model ids into display names", () => {
    expect(prettifyModelName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(prettifyModelName("claude-fable-5")).toBe("Claude Fable 5");
    expect(prettifyModelName("minimax-m3")).toBe("MiniMax M3");
    expect(prettifyModelName("glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(prettifyModelName("kimi-k2-thinking")).toBe("Kimi K2 Thinking");
    expect(prettifyModelName("qwen3.5-plus")).toBe("Qwen3.5 Plus");
  });

  test("providerLabel distinguishes every backend family", () => {
    expect(providerLabel(gatewayModel({}))).toBe("OpenCode Zen");
    expect(providerLabel(gatewayModel({ providerId: "opencode-go", source: "gateway" }))).toBe("OpenCode Go");
    expect(providerLabel(gatewayModel({ source: "console" }))).toBe("OpenCode Console");
    expect(providerLabel(gatewayModel({ providerId: "openai" }))).toBe("OpenAI (native)");
    expect(providerLabel(gatewayModel({ providerId: "chatgpt" }))).toBe("ChatGPT (native)");
  });

  test("sorts models by backend family", () => {
    const sorted = sortModelsByGroup([
      gatewayModel({ providerId: "openai", id: "openai/x", rawModelId: "x" }),
      gatewayModel({ providerId: "opencode-go", id: "opencode-go/x", rawModelId: "x", source: "gateway" }),
      gatewayModel({ source: "console" }),
      gatewayModel({ providerId: "chatgpt", id: "chatgpt/x", rawModelId: "x" }),
    ]);
    expect(sorted.map((model) => providerLabel(model))).toEqual([
      "OpenCode Console",
      "OpenCode Go",
      "ChatGPT (native)",
      "OpenAI (native)",
    ]);
  });

  test("nativeChatGptModels uses the chatgpt backend and respects the env list", () => {
    const defaults = nativeChatGptModels();
    expect(defaults.map((model) => model.id)).toContain("chatgpt/gpt-6-astra");
    expect(defaults[0]!.providerId).toBe("chatgpt");
    expect(defaults[0]!.endpoint).toBe("responses");
    expect(defaults[0]!.baseUrl).toContain("backend-api/codex");
    setEnv("OC3_CHATGPT_MODELS", "gpt-6-astra");
    expect(nativeChatGptModels().map((model) => model.id)).toEqual(["chatgpt/gpt-6-astra"]);
    setEnv("OC3_CHATGPT_MODELS", "");
    expect(nativeChatGptModels()).toEqual([]);
    setEnv("OC3_CHATGPT_MODELS", undefined);
  });
});

describe("gateway usage endpoint", () => {
  test("honors the OC3_GO_BASE_URL override", async () => {
    const { fetchGatewayUsage } = await import("../src/zen");
    const usage = await fetchGatewayUsage("go-key-456");
    expect(usage.usage).toBeDefined();
    expect(usage.usage).toMatchObject({ rolling: { percent: 12 } });
  });
});

describe("refresh error surfacing", () => {
  test("reports console failures without losing gateway models", async () => {
    saveCatalogSection("zen", [gatewayModel({})]);
    writeSession("session-token", "http://127.0.0.1:59998");
    const { refreshModels } = await import("../src/console");
    const result = await refreshModels(auth);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.models.find((model) => model.providerId === "opencode")).toBeDefined();
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });
});

describe("console org headers", () => {
  test("sends both x-org-id and x-opencode-org-id on console-routed requests", async () => {
    saveCatalogSection("console", [gatewayModel({ source: "console", providerId: "console-org", id: "console-org/gpt-model", baseUrl: `http://127.0.0.1:${GO_PORT}/v1` })]);
    writeSession("session-token");
    const handle = await startServer({ port: PROXY_PORT + 4, auth });
    const response = await postResponses(handle.port, {
      model: "console-org/gpt-model",
      stream: true,
      store: false,
      input: "hello",
    });
    expect(response.status).toBe(200);
    const request = goRequests[goRequests.length - 1]!;
    expect(request.headers.authorization).toBe("Bearer session-token");
    expect(request.headers["x-org-id"]).toBe("org-1");
    expect(request.headers["x-opencode-org-id"]).toBe("org-1");
    handle.stop();
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });
});

describe("oc3 proxy server with gateway models", () => {
  beforeAll(() => {
    saveKeys({ zen: "zen-key-123" });
    saveCatalogSection("zen", [
      gatewayModel({}),
      gatewayModel({ id: "opencode/gemini-flash", rawModelId: "gemini-flash", endpoint: "google", name: "Gemini" }),
    ]);
    saveCatalogSection("go", [
      {
        id: "opencode-go/fast",
        rawModelId: "fast",
        providerId: "opencode-go",
        name: "Fast",
        contextLength: 200000,
        maxOutputTokens: 32000,
        reasoning: false,
        imageInput: false,
        toolCalling: true,
        endpoint: "chat-completions",
        baseUrl: `http://127.0.0.1:${GO_PORT}/v1`,
        source: "gateway",
      },
      {
        id: "opencode-go/kimi-k2-thinking",
        rawModelId: "kimi-k2-thinking",
        providerId: "opencode-go",
        name: "Kimi thinking",
        contextLength: 200000,
        maxOutputTokens: 32000,
        reasoning: true,
        imageInput: false,
        toolCalling: true,
        endpoint: "chat-completions",
        baseUrl: `http://127.0.0.1:${GO_PORT}/v1`,
        source: "gateway",
      },
    ]);
    saveCatalogSection("console", []);
  });

  test("proxies Responses requests to Zen with the gateway key and parity extras", async () => {
    zenRequests.length = 0;
    const handle = await startServer({ port: PROXY_PORT, auth });
    const response = await postResponses(handle.port, {
      model: "opencode/gpt-model",
      stream: true,
      store: false,
      input: "hello",
      include: ["file_search_call"],
      reasoning: { effort: "high" },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(text).toContain('"type":"ping"');
    expect(zenRequests).toHaveLength(1);
    const request = zenRequests[0]!;
    expect(request.url).toBe(`http://127.0.0.1:${ZEN_PORT}/v1/responses`);
    expect(request.headers.authorization).toBe("Bearer zen-key-123");
    expect(request.headers["x-opencode-client"]).toBe("oc3");
    expect(request.headers["x-opencode-project"]).toBe("oc3");
    expect(request.body.prompt_cache_key).toBeString();
    expect(request.body.include).toContain("reasoning.encrypted_content");
    expect(request.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    handle.stop();
  });

  test("bridges Go chat-completions models and tolerates the trailing cost chunk", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: PROXY_PORT + 1, auth });
    const response = await postResponses(handle.port, {
      model: "opencode-go/fast",
      stream: true,
      store: false,
      input: "hello",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("response.output_text.delta");
    expect(goRequests).toHaveLength(1);
    expect(goRequests[0]!.headers.authorization).toBe("Bearer zen-key-123");
    expect("chat_template_args" in goRequests[0]!.body).toBe(false);
    handle.stop();
  });

  test("sends gateway chat_template_args to thinking-mode chat models", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: PROXY_PORT + 3, auth });
    const response = await postResponses(handle.port, {
      model: "opencode-go/kimi-k2-thinking",
      stream: true,
      store: false,
      input: "hello",
      reasoning: { effort: "high" },
    });
    expect(response.status).toBe(200);
    const request = goRequests[goRequests.length - 1]!;
    expect(request.body.model).toBe("kimi-k2-thinking");
    expect(request.body.chat_template_args).toEqual({ enable_thinking: true });
    handle.stop();
  });

  test("messages models on the gateway use the gateway key via x-api-key", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: PROXY_PORT + 2, auth });
    saveCatalogSection("go", [
      {
        id: "opencode-go/minimax-m3",
        rawModelId: "minimax-m3",
        providerId: "opencode-go",
        name: "MiniMax",
        contextLength: 200000,
        maxOutputTokens: 32000,
        reasoning: true,
        imageInput: false,
        toolCalling: true,
        endpoint: "messages",
        baseUrl: `http://127.0.0.1:${GO_PORT}/v1`,
        source: "gateway",
      },
    ]);
    const response = await postResponses(handle.port, {
      model: "opencode-go/minimax-m3",
      stream: true,
      store: false,
      input: "hello",
      reasoning: { effort: "high" },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.completed");
    expect(goRequests[goRequests.length - 1]!.headers["x-api-key"]).toBe("zen-key-123");
    expect(goRequests[goRequests.length - 1]!.headers["anthropic-version"]).toBe("2023-06-01");
    handle.stop();
    saveCatalogSection("go", []);
  });
});
