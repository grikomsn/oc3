import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { startServer } from "../src/server";
import { OpenCodeAuth } from "../src/auth";

const HOME = "/tmp/oc3-server-test";
const UPSTREAM_PORT = 8891;
const PROXY_PORT = 8892;

let chatRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
let responsesRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: UPSTREAM_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json() as Record<string, unknown>;
    const headers = Object.fromEntries(request.headers.entries());
    if (url.pathname.endsWith("/chat/completions")) {
      chatRequests.push({ url: url.href, headers, body });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"he"}}]}\n\n'));
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]}}]}\n\n'));
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n'));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/responses")) {
      responsesRequests.push({ url: url.href, headers, body });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
          controller.enqueue(enc.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

async function writeCatalog(): Promise<void> {
  mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
  writeFileSync(`${HOME}/.config/oc3/models.json`, JSON.stringify([
    {
      id: "acme/fast-model",
      rawModelId: "fast-model",
      providerId: "acme",
      name: "Fast",
      contextLength: 128000,
      maxOutputTokens: 8192,
      reasoning: false,
      imageInput: false,
      toolCalling: true,
      endpoint: "chat-completions",
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    },
    {
      id: "acme/gpt-model",
      rawModelId: "gpt-model",
      providerId: "acme",
      name: "GPT",
      contextLength: 200000,
      maxOutputTokens: 32000,
      reasoning: true,
      imageInput: false,
      toolCalling: true,
      endpoint: "responses",
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    },
  ]));
}

const auth = new OpenCodeAuth();

beforeAll(() => {
  chatRequests = [];
  responsesRequests = [];
  process.env.OC3_HOME = `${HOME}/.config/oc3`;
  process.env.OC3_TEST_TOKEN = "test";
  return writeCatalog();
});

afterAll(() => {
  upstream.stop(true);
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.OC3_TEST_TOKEN;
});

describe("oc3 proxy server", () => {
  test("bridges chat-completions models to the Responses API", async () => {
    const handle = await startServer({ port: PROXY_PORT, auth });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acme/fast-model",
        instructions: "Be brief.",
        stream: true,
        store: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
        ],
        tools: [{ type: "function", name: "shell", description: "run shell", parameters: { type: "object" } }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain("response.completed");
    expect(text).toContain("[DONE]");

    expect(chatRequests).toHaveLength(1);
    const sent = chatRequests[0]!;
    expect(sent.url).toBe(`http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`);
    expect(sent.headers.authorization).toBe("Bearer test");
    expect(sent.body.model).toBe("fast-model");
    const messages = sent.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "run it" }] });
    const tools = sent.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.function).toEqual({ name: "shell", description: "run shell", parameters: { type: "object" } });
    handle.stop();
  });

  test("passes Responses-native models through with injected headers", async () => {
    const handle = await startServer({ port: PROXY_PORT + 1, auth });
    const response = await fetch(`http://127.0.0.1:${handle.port}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acme/gpt-model",
        stream: true,
        store: false,
        input: "hi",
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(responsesRequests).toHaveLength(1);
    const sent = responsesRequests[0]!;
    expect(sent.url).toBe(`http://127.0.0.1:${UPSTREAM_PORT}/v1/responses`);
    expect(sent.body.model).toBe("gpt-model");
    expect(sent.body.store).toBe(false);
    handle.stop();
  });

  test("rejects unbridged endpoint kinds with 501", async () => {
    mkdirSync(`${process.env.OC3_HOME}`, { recursive: true });
    writeFileSync(`${process.env.OC3_HOME}/models.json`, JSON.stringify([
      {
        id: "acme/claude-model",
        rawModelId: "claude-x",
        providerId: "acme",
        name: "Claude",
        contextLength: 200000,
        maxOutputTokens: 8192,
        reasoning: true,
        imageInput: false,
        toolCalling: true,
        endpoint: "messages",
        baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      },
    ]));
    const handle = await startServer({ port: PROXY_PORT + 2, auth });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "acme/claude-model", stream: true, input: "hi" }),
    });
    expect(response.status).toBe(501);
    handle.stop();
  });
});

describe("native OpenAI bridge", () => {
  test("routes openai/ models through the configured base URL", async () => {
    mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
    writeFileSync(`${HOME}/.config/oc3/models.json`, JSON.stringify([]));
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OC3_OPENAI_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;
    try {
      const handle = await startServer({ port: PROXY_PORT + 3, auth });
      const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.6-sol", stream: true, store: false, input: "hi" }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: response.created");
      expect(responsesRequests.length).toBeGreaterThanOrEqual(1);
      const sent = responsesRequests.at(-1)!;
      expect(sent.url).toBe(`http://127.0.0.1:${UPSTREAM_PORT}/v1/responses`);
      expect(sent.headers.authorization).toBe("Bearer sk-test");
      expect(sent.body.model).toBe("gpt-5.6-sol");
      handle.stop();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OC3_OPENAI_BASE_URL;
    }
  });

  test("openai/ models are unavailable without OPENAI_API_KEY", async () => {
    delete process.env.OPENAI_API_KEY;
    writeFileSync(`${HOME}/.config/oc3/models.json`, JSON.stringify([]));
    const handle = await startServer({ port: PROXY_PORT + 4, auth });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.6-sol", stream: true, input: "hi" }),
    });
    expect(response.status).toBe(404);
    handle.stop();
  });
});

describe("transport fallbacks", () => {
  test("websocket upgrade attempts get 426 so Codex falls back to HTTP", async () => {
    const handle = await startServer({ port: PROXY_PORT + 5, auth });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
    });
    expect(response.status).toBe(426);
    handle.stop();
  });

  test("accepts zstd-compressed request bodies", async () => {
    await writeCatalog();
    const handle = await startServer({ port: PROXY_PORT + 6, auth });
    const payload = JSON.stringify({ model: "acme/gpt-model", stream: true, store: false, input: "hi" });
    const compressed = Bun.zstdCompressSync(Buffer.from(payload));
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "zstd" },
      body: new Uint8Array(compressed),
    });
    expect(response.status).toBe(200);
    handle.stop();
  });
});
