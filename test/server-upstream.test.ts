import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { OpenCodeAuth } from "../src/auth";

type Handler = (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;

let home: string;
let upstreamHandler: Handler = () => new Response("not configured", { status: 500 });
const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
let upstream: ReturnType<typeof Bun.serve>;
let base: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function sse(frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function modelEntry(id: string, endpoint: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    rawModelId: id.split("/")[1],
    providerId: "acme",
    name: id,
    contextLength: 128000,
    maxOutputTokens: 8192,
    reasoning: false,
    imageInput: false,
    toolCalling: true,
    endpoint,
    baseUrl: `${base}/v1`,
    ...extra,
  };
}

function writeCatalog(models: Array<Record<string, unknown>>): void {
  writeFileSync(join(home, "models.json"), JSON.stringify({ version: 3, console: models, go: [], updatedAt: {} }));
}

async function post(port: number, body: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const auth = new OpenCodeAuth();

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "oc3-server-upstream-"));
  setEnv("OC3_HOME", home);
  setEnv("OC3_TEST_TOKEN", "test");
  setEnv("OC3_WEBSEARCH_PROVIDER", "exa");
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const text = await request.text();
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      seen.push({ path: pathname, body });
      if (pathname === "/mcp") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "search result" }] } });
      }
      return await upstreamHandler(new Request(request.url, { method: request.method, headers: request.headers }), body);
    },
  });
  base = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) setEnv(key, value);
});

describe("upstream retry policy", () => {
  test("a persistent 429 stops after the bounded number of attempts", async () => {
    writeCatalog([modelEntry("acme/chat", "chat-completions")]);
    seen.length = 0;
    upstreamHandler = () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    const handle = await startServer({ port: 0, auth });
    const response = await post(handle.port, { model: "acme/chat", stream: true, store: false, input: "hi" });
    expect(response.status).toBe(429);
    expect(seen.filter((entry) => entry.path.endsWith("/chat/completions"))).toHaveLength(4);
    handle.stop();
  });

  test("retries a responses-path 500 'Router Unavailable' once and then streams", async () => {
    writeCatalog([modelEntry("acme/native", "responses")]);
    seen.length = 0;
    let calls = 0;
    upstreamHandler = () => {
      calls += 1;
      if (calls === 1) return new Response("Router Unavailable", { status: 500 });
      return sse([JSON.stringify({ type: "response.completed", response: { id: "r1", output: [] } })]);
    };
    const handle = await startServer({ port: 0, auth });
    const response = await post(handle.port, { model: "acme/native", stream: true, store: false, input: "hi" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    expect(calls).toBe(2);
    handle.stop();
  });

});

describe("client disconnects", () => {
  test("aborting the client cancels the upstream stream", async () => {
    writeCatalog([modelEntry("acme/stream", "chat-completions")]);
    let cancelled = false;
    upstreamHandler = () => {
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          timer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
            } catch {
              clearInterval(timer);
            }
          }, 20);
        },
        cancel() {
          cancelled = true;
          clearInterval(timer);
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    };
    const handle = await startServer({ port: 0, auth });
    const client = new AbortController();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "acme/stream", stream: true, store: false, input: "hi" }),
      signal: client.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    client.abort();
    reader.cancel().catch(() => {});
    const deadline = Date.now() + 3000;
    while (!cancelled && Date.now() < deadline) await Bun.sleep(25);
    expect(cancelled).toBe(true);
    handle.stop();
  });
});

describe("request handling", () => {
  test("rejects request bodies that are not JSON objects", async () => {
    writeCatalog([modelEntry("acme/chat", "chat-completions")]);
    const handle = await startServer({ port: 0, auth });
    expect((await post(handle.port, "null")).status).toBe(400);
    expect((await post(handle.port, "[1,2]")).status).toBe(400);
    handle.stop();
  });

  test("bridged messages requests keep custom tool calls and their outputs", async () => {
    writeCatalog([modelEntry("acme/claude", "messages")]);
    seen.length = 0;
    upstreamHandler = () => sse([]);
    const handle = await startServer({ port: 0, auth });
    await post(handle.port, {
      model: "acme/claude",
      stream: true,
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "patch it" }] },
        { type: "custom_tool_call", id: "i1", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "c1", output: "done" },
      ],
    }).then((response) => response.text());
    const sent = seen.find((entry) => entry.path.endsWith("/messages"));
    expect(sent).toBeDefined();
    const wire = JSON.stringify(sent!.body.messages);
    expect(wire).toContain('"type":"tool_use"');
    expect(wire).toContain('"type":"tool_result"');
    handle.stop();
  });

  test("the search loop stops at its round limit with an incomplete response", async () => {
    writeCatalog([modelEntry("acme/search", "chat-completions")]);
    setEnv("OC3_EXA_MCP_URL", `${base}/mcp`);
    seen.length = 0;
    upstreamHandler = () => sse([JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "web_search", arguments: '{"query":"q"}' } }] },
        finish_reason: "tool_calls",
      }],
    })]);
    const handle = await startServer({ port: 0, auth });
    const response = await post(handle.port, {
      model: "acme/search",
      stream: true,
      store: false,
      input: "look it up",
      tools: [{ type: "web_search" }],
    });
    const text = await response.text();
    expect(text).toContain("response.incomplete");
    expect(text).toContain("web_search_round_limit");
    expect(seen.filter((entry) => entry.path.endsWith("/chat/completions"))).toHaveLength(4);
    setEnv("OC3_EXA_MCP_URL", undefined);
    handle.stop();
  });
});
