import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { startServer } from "../src/server";
import { OpenCodeAuth } from "../src/auth";
import { clearKeys, loadKeys, loadCatalogCache, loadSessions, saveKeys, saveCatalogSection, clearModeSession, saveModeSession } from "../src/store";
import { displayName, findModel, isGatewayProvider, modelMode, modelsFromGatewayProvider, minimalGatewayModel, nativeChatGptModels, prettifyModelName, providerLabel, sortModelsByGroup, reasoningEffortsFromSource, type ProviderSource } from "../src/models";
import { writeCodexCatalog } from "../src/codex-catalog";
import { credentialForModel, credentialErrorHint, discoveryTokens } from "../src/credentials";
import { availableModels, refreshModels } from "../src/console";
import { fetchGatewayModels, gatewayChatTemplateArgs, gatewayKeyFor, gatewayResponsesExtras } from "../src/gateway";
import { envSaver, portOf, sessionFixture, tempRoot, writeLegacySession } from "./helpers";
import type { ConsoleSession } from "../src/protocol";
import type { Oc3Model } from "../src/models";

const HOME = tempRoot("oc3-gateway-test");

const consoleRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
const goRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
const consoleModelAuths: Array<string | undefined> = [];
const goModelAuths: Array<string | undefined> = [];

const consoleUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    if (url.pathname === "/v1/models") {
      consoleModelAuths.push(headers.authorization);
      return Response.json({ object: "list", data: [{ id: "opencode/gpt-model" }, { id: "opencode/gemini-flash" }, { id: "opencode/expensive-luxury" }] });
    }
    if (url.pathname.endsWith("/responses")) {
      consoleRequests.push({ url: url.href, headers, body: await request.json() as Record<string, unknown> });
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
const CONSOLE_PORT = portOf(consoleUpstream);

const goUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const headers = Object.fromEntries(request.headers.entries());
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/models") {
      goModelAuths.push(headers.authorization);
      return Response.json({ object: "list", data: [{ id: "minimax-m3" }, { id: "paid-go" }] });
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
const GO_PORT = portOf(goUpstream);

const catalogUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/api.json") {
      return Response.json({
        providers: {
          opencode: consoleCatalogProvider,
          "opencode-go": goCatalogProvider,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const CATALOG_PORT = portOf(catalogUpstream);

const consoleCatalogProvider: ProviderSource = {
  id: "opencode",
  name: "OpenCode Console",
  api: `http://127.0.0.1:${CONSOLE_PORT}/v1`,
  npm: "@ai-sdk/openai-compatible",
  models: {
    "gpt-model": {
      id: "gpt-model",
      name: "GPT via Console",
      reasoning: true,
      tool_call: true,
      attachment: true,
      limit: { context: 400000, output: 128000 },
      provider: { npm: "@ai-sdk/openai" },
      reasoning_options: [{ type: "string", values: ["low", "HIGH", "banana"] }],
      cost: { input: 1.5, output: 10, context_over_200k: 3 },
    },
    "gemini-flash": {
      name: "Gemini via Console",
      reasoning: true,
      tool_call: true,
      limit: { context: 1000000, output: 64000 },
      provider: { npm: "@ai-sdk/google" },
    },
    "expensive-luxury": { name: "Expensive Luxury", cost: { input: 9, output: 90 } },
    "paid-model": { name: "Paid", status: "deprecated" },
  },
};

const goCatalogProvider: ProviderSource = {
  name: "OpenCode Go",
  npm: "@ai-sdk/openai-compatible",
  models: {
    "minimax-m3": { name: "MiniMax via Go", reasoning: true, tool_call: true, limit: { context: 200000, output: 32000 } },
    "paid-go": { name: "Paid Go", cost: { input: 2, output: 20 } },
  },
};

function gatewayModel(overrides: Partial<Oc3Model>): Oc3Model {
  return {
    id: "opencode/gpt-model",
    rawModelId: "gpt-model",
    providerId: "opencode",
    name: "GPT via Console",
    contextLength: 400000,
    maxOutputTokens: 128000,
    reasoning: true,
    imageInput: true,
    toolCalling: true,
    endpoint: "responses",
    baseUrl: `http://127.0.0.1:${CONSOLE_PORT}/v1`,
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
const env = envSaver();
const setEnv = env.set;

beforeAll(() => {
  setEnv("OC3_HOME", `${HOME}/.config/oc3`);
  mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
  setEnv("OC3_CONSOLE_BASE_URL", `http://127.0.0.1:${CONSOLE_PORT}/v1`);
  setEnv("OC3_GO_BASE_URL", `http://127.0.0.1:${GO_PORT}/v1`);
  setEnv("OC3_GATEWAY_CATALOG_URL", `http://127.0.0.1:${CATALOG_PORT}/api.json`);
  setEnv("OPENCODE_API_KEY", undefined);
  setEnv("OC3_TEST_TOKEN", undefined);
});

afterAll(() => {
  consoleUpstream.stop(true);
  goUpstream.stop(true);
  catalogUpstream.stop(true);
  rmSync(HOME, { recursive: true, force: true });
  env.restore();
});

describe("gateway catalog parsing", () => {
  test("modelsFromGatewayProvider namespaces ids and resolves per-mode endpoints", () => {
    const console = modelsFromGatewayProvider("opencode", consoleCatalogProvider, "console");
    const ids = console.map((model) => model.id);
    expect(ids).toEqual(["opencode/gpt-model", "opencode/gemini-flash", "opencode/expensive-luxury"]);
    expect(console[0]!.endpoint).toBe("responses");
    expect(console[0]!.baseUrl).toBe(`http://127.0.0.1:${CONSOLE_PORT}/v1`);
    expect(console[0]!.imageInput).toBe(true);
    expect(console[1]!.endpoint).toBe("google");
    expect(console.map((model) => model.rawModelId)).not.toContain("paid-model");

    const go = modelsFromGatewayProvider("opencode-go", goCatalogProvider, "go");
    expect(go[0]!.id).toBe("opencode-go/minimax-m3");
    expect(go[0]!.endpoint).toBe("messages");
  });

  test("carries catalog reasoning efforts and cost metadata", () => {
    const console = modelsFromGatewayProvider("opencode", consoleCatalogProvider, "console");
    const gpt = console.find((model) => model.rawModelId === "gpt-model")!;
    expect(gpt.reasoningEfforts).toEqual(["low", "high"]);
    expect(gpt.cost).toEqual({ input: 1.5, output: 10, inputOver200k: 3 });
    const gemini = console.find((model) => model.rawModelId === "gemini-flash")!;
    expect(gemini.reasoningEfforts).toBeUndefined();
    expect(gemini.cost).toBeUndefined();
  });

  test("reasoningEffortsFromSource ignores unknown values", () => {
    expect(reasoningEffortsFromSource({ reasoning_options: [{ values: ["nope", "banana", "high"] }] })).toEqual(["high"]);
    expect(reasoningEffortsFromSource({})).toBeUndefined();
  });

  test("codex catalog derives per-model reasoning levels and routing metadata", async () => {
    const console = modelsFromGatewayProvider("opencode", consoleCatalogProvider, "console");
    await writeCodexCatalog(console);
    const codex = JSON.parse(readFileSync(`${process.env.OC3_HOME}/codex-models.json`, "utf8")) as {
      models: Array<{ slug: string; display_name: string; supported_reasoning_levels: Array<{ effort: string }>; default_reasoning_level: string }>;
    };
    const gptEntry = codex.models.find((model) => model.slug === "opencode/gpt-model")!;
    expect(gptEntry.display_name).toBe("GPT via Console [Console]");
    expect(gptEntry.supported_reasoning_levels.map((level) => level.effort)).toEqual(["low", "high"]);
    expect(gptEntry.default_reasoning_level).toBe("low");
    const routing = JSON.parse(readFileSync(`${process.env.OC3_HOME}/codex-routing.json`, "utf8")) as {
      models: Array<{ slug: string; thinking?: { levels: string[] } }>;
    };
    const routingEntry = routing.models.find((model) => model.slug === "opencode/gpt-model")!;
    expect(routingEntry.thinking?.levels).toEqual(["low", "high"]);
  });

  test("non-reasoning models expose only the thinking-off level", () => {
    writeCodexCatalog([gatewayModel({ id: "opencode/plain", rawModelId: "plain", reasoning: false })]);
    const codex = JSON.parse(readFileSync(`${process.env.OC3_HOME}/codex-models.json`, "utf8")) as {
      models: Array<{ supported_reasoning_levels: Array<{ description: string; effort: string }>; default_reasoning_level: string }>;
    };
    expect(codex.models[0]!.supported_reasoning_levels).toEqual([{ description: "Turn thinking off", effort: "none" }]);
    expect(codex.models[0]!.default_reasoning_level).toBe("none");
  });

  test("minimalGatewayModel applies heuristic endpoint kinds", () => {
    const claude = minimalGatewayModel("opencode", "console", "claude-sonnet-5");
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
  test("per-mode service keys authorize their own provider only", async () => {
    saveKeys({ console: "console-key-123", go: "go-key-456" });
    setEnv("OPENCODE_API_KEY", "env-key");
    expect(await tokenFor(gatewayModel({ providerId: "opencode" }))).toBe("console-key-123");
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("go-key-456");
    saveKeys({ console: "console-key-123" });
    // no cross-mode fallback: the console key must not authorize Go
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go" }))).toBe("env-key");
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
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
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

  test("OPENAI_API_KEY authorizes the native OpenAI bridge when set", async () => {
    setEnv("OPENAI_API_KEY", "sk-test-openai");
    const native = gatewayModel({ providerId: "openai", id: "openai/gpt-5.6-sol", rawModelId: "gpt-5.6-sol" });
    expect(await tokenFor(native)).toBe("sk-test-openai");
    expect(availableModels().map((model) => model.id)).toContain("openai/gpt-5.6-sol");
    setEnv("OPENAI_API_KEY", undefined);
    expect(availableModels().map((model) => model.id)).not.toContain("openai/gpt-5.6-sol");
  });

  test("gatewayKeyFor only resolves keys for gateway providers", () => {
    const keys = { console: "console-key", go: "go-key" };
    expect(gatewayKeyFor("opencode", keys, "env-key")).toBe("console-key");
    expect(gatewayKeyFor("opencode-go", keys, "env-key")).toBe("go-key");
    expect(gatewayKeyFor("opencode-go", {}, "env-key")).toBe("env-key");
    expect(gatewayKeyFor("openai", keys, "env-key")).toBe("");
  });

  test("isGatewayProvider and modelMode follow the gateway provider ids", () => {
    expect(isGatewayProvider("opencode")).toBe(true);
    expect(isGatewayProvider("opencode-go")).toBe(true);
    expect(isGatewayProvider("openai")).toBe(false);
    expect(isGatewayProvider("console-org")).toBe(false);
    expect(modelMode(gatewayModel({ providerId: "opencode-go" }))).toBe("go");
    expect(modelMode(gatewayModel({}))).toBe("console");
  });

  test("the Console session token only reaches same-origin Console catalog models", async () => {
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    writeSession("session-token", `http://127.0.0.1:${CONSOLE_PORT}`);
    const orgModel = (baseUrl: string): Oc3Model => gatewayModel({ providerId: "console-org", id: "console-org/model", rawModelId: "model", source: "console", baseUrl });
    expect(await tokenFor(orgModel(`http://127.0.0.1:${CONSOLE_PORT}/v1`))).toBe("session-token");
    expect(await tokenFor(orgModel("https://attacker.example/v1"))).toBeUndefined();
    expect(await tokenFor(orgModel(`http://127.0.0.1:${GO_PORT}/v1`))).toBeUndefined();
    expect(await tokenFor(gatewayModel({ providerId: "console-org", source: "gateway", baseUrl: `http://127.0.0.1:${CONSOLE_PORT}/v1` }))).toBeUndefined();
    resetSessions();
  });
});

describe("dual auth precedence", () => {
  test("service keys take precedence over the shared Console session", async () => {
    saveKeys({ console: "console-key-priority", go: "go-key-priority" });
    writeSession("session-token");
    expect(await tokenFor(gatewayModel({}))).toBe("console-key-priority");
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go", id: "opencode-go/fast", rawModelId: "fast" }))).toBe("go-key-priority");
    // console-origin models stay session-scoped even when a key exists
    const consoleOrigin = await credentialForModel(gatewayModel({ source: "console" }), auth);
    expect(consoleOrigin?.token).toBe("session-token");
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
    clearKeys();
  });

  test("the go service key beats a go slot session", async () => {
    resetSessions();
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    saveKeys({ go: "go-key-priority" });
    saveModeSession("go", goSlotSession("go-slot-token"));
    expect(await tokenFor(goModel())).toBe("go-key-priority");
    clearKeys();
    expect(await tokenFor(goModel())).toBe("go-slot-token");
    resetSessions();
  });

  test("the shared Console session authorizes gateway models without a key", async () => {
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    writeSession("session-token");
    expect(await tokenFor(gatewayModel({}))).toBe("session-token");
    expect(await tokenFor(gatewayModel({ providerId: "opencode-go", id: "opencode-go/fast", rawModelId: "fast" }))).toBe("session-token");
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });

  test("the go slot's session wins over the console-compat fallback", async () => {
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    writeSession("console-slot-token");
    saveModeSession("go", goSlotSession("go-slot-token"));
    expect(await tokenFor(gatewayModel({}))).toBe("console-slot-token");
    expect(await tokenFor(goModel())).toBe("go-slot-token");
    clearModeSession("go");
    // compat: without a go sign-in the console slot's shared session applies
    expect(await tokenFor(goModel())).toBe("console-slot-token");
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });

  test("anonymous gateway requests keep the public sentinel", async () => {
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    expect(await tokenFor(gatewayModel({}))).toBe("public");
  });
});

function goModel(): Oc3Model {
  return gatewayModel({ providerId: "opencode-go", id: "opencode-go/fast", rawModelId: "fast" });
}

function goSlotSession(token: string): ConsoleSession {
  return sessionFixture({ token, accountId: "acct-b", email: "b@example.com", orgId: "org-b", orgName: "Org B" });
}

function writeSession(token: string, server = "https://opencode.ai/console"): void {
  writeLegacySession(process.env.OC3_HOME!, token, server);
}

async function tokenFor(model: Oc3Model): Promise<string | undefined> {
  return (await credentialForModel(model, auth))?.token;
}

function resetSessions(): void {
  rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
  rmSync(`${process.env.OC3_HOME}/session.json`, { force: true });
}

function expiredSession(session: ConsoleSession): ConsoleSession {
  return { ...session, expiresAt: Date.now() - 1000 };
}

/** Fake auth fetcher: every upstream call gets the same response; calls are recorded. */
function refreshFetcher(respond: () => Response): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return respond();
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("keys store", () => {
  test("persists 0600 keys.json in OC3_HOME", () => {
    saveKeys({ console: "secret-console-key" });
    const path = `${process.env.OC3_HOME}/keys.json`;
    expect(existsSync(path)).toBe(true);
    expect(loadKeys().console).toBe("secret-console-key");
    chmodSync(path, 0o644);
    saveKeys({ console: "secret-console-key" });
    expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("undefined");
    clearKeys();
    expect(loadKeys()).toEqual({});
  });
});

describe("legacy state migration", () => {
  test("migrates the legacy zen key slot to console and rewrites keys.json", () => {
    const path = `${process.env.OC3_HOME}/keys.json`;
    writeFileSync(path, JSON.stringify({ zen: "legacy-zen-key", go: "go-key-456" }), { mode: 0o600 });
    expect(loadKeys()).toEqual({ console: "legacy-zen-key", go: "go-key-456" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ console: "legacy-zen-key", go: "go-key-456" });
    clearKeys();
  });

  test("rewrites only when the legacy slot is present", () => {
    const path = `${process.env.OC3_HOME}/keys.json`;
    writeFileSync(path, JSON.stringify({ console: "kept", go: "go-key" }), { mode: 0o600 });
    expect(loadKeys()).toEqual({ console: "kept", go: "go-key" });
    expect(JSON.parse(readFileSync(path, "utf8")).console).toBe("kept");
    clearKeys();
  });

  test("remaps the v2 models.json zen section into console", () => {
    const path = `${process.env.OC3_HOME}/models.json`;
    const orgModel = gatewayModel({ source: "console" });
    writeFileSync(path, JSON.stringify({ version: 2, console: [orgModel], zen: [gatewayModel({})], go: [gatewayModel({ providerId: "opencode-go", id: "opencode-go/x" })], updatedAt: { zen: 111, go: 222 } }));
    const cache = loadCatalogCache();
    expect(cache.console).toEqual([orgModel]);
    expect(cache.go).toHaveLength(1);
    expect(cache.updatedAt).toEqual({});
    writeFileSync(path, JSON.stringify({ version: 2, console: [], zen: [gatewayModel({})], go: [] }));
    // with no org models, the public zen catalog becomes the console section
    expect(loadCatalogCache().console).toHaveLength(1);
    rmSync(path);
  });
});

describe("gateway catalog fetch", () => {
  test("merges live /models with models.dev enrichment", async () => {
    const models = await fetchGatewayModels("console");
    expect(models).toBeDefined();
    const gpt = models!.find((model) => model.rawModelId === "gpt-model");
    expect(gpt?.contextLength).toBe(400000);
    expect(gpt?.baseUrl).toBe(`http://127.0.0.1:${CONSOLE_PORT}/v1`);
    // live list is authoritative: catalog-only entries are dropped
    expect(models!.find((model) => model.rawModelId === "paid-model")).toBeUndefined();
    const goModels = await fetchGatewayModels("go");
    const minimax = goModels!.find((model) => model.rawModelId === "minimax-m3");
    expect(minimax?.baseUrl).toContain("/zen/go/v1");
    expect(minimax?.endpoint).toBe("messages");
  });

  test("returns undefined when the live catalog is unreachable", async () => {
    setEnv("OC3_CONSOLE_BASE_URL", "http://127.0.0.1:59999/v1");
    expect(await fetchGatewayModels("console")).toBeUndefined();
    setEnv("OC3_CONSOLE_BASE_URL", `http://127.0.0.1:${CONSOLE_PORT}/v1`);
  });

  test("legacy OC3_ZEN_BASE_URL still overrides the console gateway", async () => {
    setEnv("OC3_CONSOLE_BASE_URL", undefined);
    setEnv("OC3_ZEN_BASE_URL", "http://127.0.0.1:59999/v1");
    expect(await fetchGatewayModels("console")).toBeUndefined();
    setEnv("OC3_ZEN_BASE_URL", undefined);
    setEnv("OC3_CONSOLE_BASE_URL", `http://127.0.0.1:${CONSOLE_PORT}/v1`);
  });

  test("refresh keeps the cached section when the gateway is down", async () => {
    saveCatalogSection("console", [gatewayModel({})]);
    setEnv("OC3_CONSOLE_BASE_URL", "http://127.0.0.1:59999/v1");
    const { refreshGatewayCatalogs } = await import("../src/console");
    const result = await refreshGatewayCatalogs();
    expect(result.errors.some((message) => message.includes("Console catalog unreachable"))).toBe(true);
    expect(loadCatalogCache().console).toHaveLength(1);
    setEnv("OC3_CONSOLE_BASE_URL", `http://127.0.0.1:${CONSOLE_PORT}/v1`);
  });

  test("skips the public console refresh when a Console session supersedes it", async () => {
    const { refreshGatewayCatalogs } = await import("../src/console");
    saveCatalogSection("console", []);
    const result = await refreshGatewayCatalogs({ skipConsole: true });
    expect(result.console).toEqual([]);
    expect(result.errors.some((message) => message.includes("Console catalog unreachable"))).toBe(false);
    expect(loadCatalogCache().console).toEqual([]);
    expect((loadCatalogCache().go as Oc3Model[]).map((model) => model.rawModelId)).toEqual(["minimax-m3", "paid-go"]);
    await refreshGatewayCatalogs();
    // anonymous discovery keeps only free models (gpt-model has a positive cost)
    expect((loadCatalogCache().console as Oc3Model[]).map((model) => model.rawModelId)).toEqual(["gemini-flash"]);
  });

  test("anonymous console discovery filters paid models and sends no Bearer", async () => {
    const { refreshGatewayCatalogs } = await import("../src/console");
    consoleModelAuths.length = 0;
    const result = await refreshGatewayCatalogs({});
    expect(consoleModelAuths[0]).toBeUndefined();
    expect(result.console.map((model) => model.rawModelId)).toEqual(["gemini-flash"]);
    expect(result.console.map((model) => model.rawModelId)).not.toContain("expensive-luxury");
    expect(result.console.map((model) => model.rawModelId)).not.toContain("gpt-model");
    expect(loadCatalogCache().console as Oc3Model[]).toEqual(result.console);
  });

  test("credentialed discovery sends Bearer and keeps the full console list", async () => {
    const { refreshGatewayCatalogs } = await import("../src/console");
    consoleModelAuths.length = 0;
    goModelAuths.length = 0;
    const result = await refreshGatewayCatalogs({ consoleToken: "console-key-123", goToken: "go-key-456" });
    expect(consoleModelAuths[0]).toBe("Bearer console-key-123");
    expect(goModelAuths[0]).toBe("Bearer go-key-456");
    expect(result.console.map((model) => model.rawModelId)).toContain("expensive-luxury");
    expect(result.console.map((model) => model.rawModelId)).toContain("gpt-model");
  });

  test("go discovery never filters paid models, even anonymously", async () => {
    const { refreshGatewayCatalogs } = await import("../src/console");
    goModelAuths.length = 0;
    const result = await refreshGatewayCatalogs({});
    expect(goModelAuths[0]).toBeUndefined();
    expect(result.go.map((model) => model.rawModelId)).toContain("paid-go");
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

  test("display names carry bracketed backend tags that routing strips", () => {
    expect(displayName(gatewayModel({}))).toBe("GPT via Console [Console]");
    expect(displayName(gatewayModel({ providerId: "opencode-go", source: "gateway" }))).toBe("GPT via Console [Go]");
    expect(displayName(gatewayModel({ source: "console" }))).toBe("GPT via Console [Console]");
    expect(displayName(gatewayModel({ providerId: "chatgpt", name: "GPT 6 Astra" }))).toBe("GPT 6 Astra [ChatGPT]");
    const found = findModel([gatewayModel({ id: "acme/gpt-model", rawModelId: "gpt-model", providerId: "acme", name: "GPT 5.6 Sol" })], "acme/gpt-model [Console]");
    expect(found?.id).toBe("acme/gpt-model");
  });

  test("providerLabel distinguishes every backend family", () => {
    expect(providerLabel(gatewayModel({}))).toBe("OpenCode Console");
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
    const { fetchGatewayUsage } = await import("../src/gateway");
    const usage = await fetchGatewayUsage("go-key-456");
    expect(usage.usage).toBeDefined();
    expect(usage.usage).toMatchObject({ rolling: { percent: 12 } });
  });
});

describe("refresh error surfacing", () => {
  test("reports console failures without losing gateway models", async () => {
    saveCatalogSection("console", [gatewayModel({})]);
    writeSession("session-token", "http://127.0.0.1:59998");
    const { refreshModels } = await import("../src/console");
    const result = await refreshModels(auth);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.models.find((model) => model.providerId === "opencode")).toBeDefined();
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });
});

describe("expired slot sessions", () => {
  test("a failed refresh rejects getCredential with the upstream status", async () => {
    resetSessions();
    saveModeSession("console", expiredSession(sessionFixture({ token: "console-expired" })));
    const { fetcher } = refreshFetcher(() => new Response("denied", { status: 401 }));
    await expect(new OpenCodeAuth(fetcher).getCredential("console")).rejects.toThrow("token refresh failed (401)");
    resetSessions();
  });

  test("concurrent credential reads share one token refresh", async () => {
    resetSessions();
    saveModeSession("console", expiredSession(sessionFixture({ token: "console-expired", refreshToken: "console-refresh" })));
    const { fetcher, calls } = refreshFetcher(() => Response.json({ access_token: "console-fresh", refresh_token: "console-refresh-2", expires_in: 3600 }));
    const refreshing = new OpenCodeAuth(fetcher);
    const credentials = await Promise.all([refreshing.getCredential("console"), refreshing.getCredential("console"), refreshing.getCredential("console")]);
    expect(credentials.map((credential) => credential.token)).toEqual(["console-fresh", "console-fresh", "console-fresh"]);
    expect(calls).toHaveLength(1);
    resetSessions();
  });

  test("discovery refreshes an expired go slot before sending its token", async () => {
    resetSessions();
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    saveModeSession("go", expiredSession(goSlotSession("go-expired")));
    const { fetcher, calls } = refreshFetcher(() => Response.json({ access_token: "go-fresh", refresh_token: "go-fresh-refresh", expires_in: 3600 }));
    const tokens = await discoveryTokens(new OpenCodeAuth(fetcher));
    expect(tokens).toEqual({ goToken: "go-fresh", errors: [] });
    expect(calls).toEqual(["https://opencode.ai/console/auth/device/token"]);
    expect(loadSessions().go?.accessToken).toBe("go-fresh");
    resetSessions();
  });

  test("a failed console refresh is reported and go discovery still runs", async () => {
    resetSessions();
    clearKeys();
    setEnv("OPENCODE_API_KEY", undefined);
    saveModeSession("console", expiredSession(sessionFixture({ token: "console-expired" })));
    const { fetcher, calls } = refreshFetcher(() => new Response("denied", { status: 401 }));
    const failing = new OpenCodeAuth(fetcher);
    const tokens = await discoveryTokens(failing);
    expect(tokens.consoleToken).toBeUndefined();
    expect(tokens.goToken).toBeUndefined();
    expect(tokens.errors).toEqual(["OpenCode console token refresh failed (401)"]);
    expect(calls).toHaveLength(1);
    goModelAuths.length = 0;
    const result = await refreshModels(failing);
    expect(result.errors).toEqual(["OpenCode console token refresh failed (401)"]);
    expect(goModelAuths).toHaveLength(1);
    expect(result.models.some((model) => model.providerId === "opencode-go")).toBe(true);
    resetSessions();
  });
});

describe("console org headers", () => {
  test("sends both x-org-id and x-opencode-org-id on console-routed requests", async () => {
    saveCatalogSection("console", [gatewayModel({ source: "console", providerId: "console-org", id: "console-org/gpt-model", baseUrl: `http://127.0.0.1:${GO_PORT}/v1` })]);
    writeSession("session-token", `http://127.0.0.1:${GO_PORT}`);
    const handle = await startServer({ port: 0, auth });
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
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });

  test("go gateway requests carry the acting go slot's org headers", async () => {
    saveCatalogSection("go", [{
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
    }]);
    writeSession("console-slot-token");
    saveModeSession("go", goSlotSession("go-slot-token"));
    const handle = await startServer({ port: 0, auth });
    const response = await postResponses(handle.port, {
      model: "opencode-go/fast",
      stream: true,
      store: false,
      input: "hello",
    });
    expect(response.status).toBe(200);
    const request = goRequests[goRequests.length - 1]!;
    expect(request.headers.authorization).toBe("Bearer go-slot-token");
    expect(request.headers["x-org-id"]).toBe("org-b");
    expect(request.headers["x-opencode-org-id"]).toBe("org-b");
    handle.stop();
    rmSync(`${process.env.OC3_HOME}/sessions.json`, { force: true });
    rmSync(`${process.env.OC3_HOME}/session.json`);
  });
});

describe("oc3 proxy server with gateway models", () => {
  beforeAll(() => {
    saveKeys({ console: "console-key-123", go: "go-key-456" });
    saveCatalogSection("console", [
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
  });

  test("proxies Responses requests to Console with the service key and parity extras", async () => {
    consoleRequests.length = 0;
    const handle = await startServer({ port: 0, auth });
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
    expect(consoleRequests).toHaveLength(1);
    const request = consoleRequests[0]!;
    expect(request.url).toBe(`http://127.0.0.1:${CONSOLE_PORT}/v1/responses`);
    expect(request.headers.authorization).toBe("Bearer console-key-123");
    expect(request.headers["x-opencode-client"]).toBe("oc3");
    expect(request.headers["x-opencode-project"]).toBe("oc3");
    expect(request.body.prompt_cache_key).toBeString();
    expect(request.body.include).toContain("reasoning.encrypted_content");
    expect(request.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    handle.stop();
  });

  test("bridges Go chat-completions models and tolerates the trailing cost chunk", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: 0, auth });
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
    expect(goRequests[0]!.headers.authorization).toBe("Bearer go-key-456");
    expect("chat_template_args" in goRequests[0]!.body).toBe(false);
    handle.stop();
  });

  test("sends gateway chat_template_args to thinking-mode chat models", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: 0, auth });
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

  test("messages models on the gateway use the go service key via x-api-key", async () => {
    goRequests.length = 0;
    const handle = await startServer({ port: 0, auth });
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
    expect(goRequests[goRequests.length - 1]!.headers["x-api-key"]).toBe("go-key-456");
    expect(goRequests[goRequests.length - 1]!.headers["anthropic-version"]).toBe("2023-06-01");
    handle.stop();
    saveCatalogSection("go", []);
  });
});