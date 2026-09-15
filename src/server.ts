import { OpenCodeAuth } from "./auth";
import { availableModels } from "./console";
import { findModel, type Oc3Model } from "./models";
import { buildRequestHeaders, endpointUrl, newId, USER_AGENT } from "./protocol";
import { formatSseEvent, parseSseData, responsesRequestToChat, ChatStreamToResponses } from "./translate";
import { analyzeHttp400ForRetry, isTransientNetworkError, isTransientServerError, retryDelayMs } from "./retry";
import { SseParser } from "./sse-parser";
import { applyReasoningWire, normalizeFullAccessExecTool, normalizeInputItems, normalizeReasoningForModel, resolveAutoReview, TurnModelCache } from "./desktop-normalize";
import { thinkingMetadataFor } from "./routing-catalog";
import { executeWebSearch, searchBridgeNeeded, stripHostedSearchTool } from "./web-search";
import { truncatedStopReason } from "./stop-reason";

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function zeroUsage(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}
import { anthropicRequestFromResponses, AnthropicStreamToResponses } from "./anthropic-bridge";
import { googleRequestFromResponses, GoogleStreamToResponses } from "./google-bridge";

export interface ServerHandle {
  port: number;
  stop(): void;
  requestCount(): number;
}

export function startServer(options: { port: number; auth: OpenCodeAuth }): Promise<ServerHandle> {
  const auth = options.auth;
  let requests = 0;
  const sessionId = newId("sess");
  const turnModels = new TurnModelCache();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      try {
        if (request.method === "GET" && (path === "/health" || path === "/")) {
          const models = availableModels();
          return json({ ok: true, models: models.length, signedIn: auth.isSignedIn(), requests });
        }
        if (request.method === "GET" && (path === "/models" || path === "/v1/models")) {
          const models = availableModels();
          return json({ object: "list", data: models.map((model) => ({ id: model.id, object: "model", owned_by: model.providerId })) });
        }
        if (request.method === "GET" && (path === "/responses" || path === "/v1/responses" || path === "/backend-api/codex/responses")
          && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          // Codex treats 426 as a session-wide fallback to HTTP POST (verified
          // against ollama's internal/proxy/codex_desktop.go).
          return json({ error: { message: "oc3 uses the HTTP Responses transport" } }, 426);
        }
        const responsesMatch = request.method === "POST" && (path === "/responses" || path === "/v1/responses" || path === "/backend-api/codex/responses");
        if (responsesMatch) {
          requests += 1;
          return await handleResponses(request, auth, sessionId, turnModels);
        }
        return json({ error: { message: `Not found: ${request.method} ${path}` } }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: { message } }, 500);
      }
    },
  });
  const listenPort = typeof server.port === "number" ? server.port : options.port;
  return Promise.resolve({
    port: listenPort,
    stop: () => server.stop(true),
    requestCount: () => requests,
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (!encoding) return await request.json() as Record<string, unknown>;
  const compressed = new Uint8Array(await request.arrayBuffer());
  let decoded: Uint8Array;
  if (encoding === "zstd") {
    decoded = Bun.zstdDecompressSync(compressed);
  } else if (encoding === "gzip") {
    decoded = Bun.gunzipSync(compressed);
  } else if (encoding === "deflate") {
    decoded = Bun.inflateSync(compressed);
  } else if (encoding === "identity" || encoding === "") {
    decoded = compressed;
  } else {
    throw new Error(`Unsupported Content-Encoding: ${encoding}`);
  }
  return JSON.parse(new TextDecoder().decode(decoded)) as Record<string, unknown>;
}

async function handleResponses(request: Request, auth: OpenCodeAuth, sessionId: string, turnModels: TurnModelCache): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseRequestBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON body";
    return json({ error: { message } }, 400);
  }
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const models = availableModels();
  let model = findModel(models, requestedModel);
  if (!model) {
    const autoReview = resolveAutoReview(requestedModel, body, turnModels, pickDefaultModel(models));
    if (autoReview) {
      body = autoReview.body;
      model = findModel(models, autoReview.model);
    }
  }
  if (!model) {
    // Unknown model: fall through to the native backends with the client's own
    // auth headers (ollama codex_desktop.go parity) so real OpenAI/ChatGPT
    // models keep working through oc3.
    if (requestedModel) {
      return await passthroughNative(request, body);
    }
    return json({
      error: {
        message: `Unknown model ${JSON.stringify(requestedModel)}. Run \`oc3 models\` to refresh the catalog.`,
      },
    }, 404);
  }
  if (model.endpoint === "messages" || model.endpoint === "google") {
    return await handleBridgedEndpoint(request, body, model, auth, sessionId);
  }
  if (model.endpoint === "chat-completions" && body.stream !== true) {
    return json({ error: { message: "oc3 only proxies streaming requests (stream: true)" } }, 400);
  }

  const credential = model.providerId === "openai"
    ? { token: process.env.OPENAI_API_KEY ?? "", server: "", orgId: undefined, orgName: undefined }
    : process.env.OC3_TEST_TOKEN
      ? { token: process.env.OC3_TEST_TOKEN, server: "", orgId: undefined, orgName: undefined }
      : await auth.getCredential();
  if (!credential.token) {
    return json({ error: { message: "No credentials for this model provider" } }, 401);
  }

  const desktopNormalized = normalizeInputItems(body);
  body = desktopNormalized.body;
  const sandboxMode = typeof body.sandbox_mode === "string" ? body.sandbox_mode : undefined;
  const execNormalized = normalizeFullAccessExecTool(body, sandboxMode);
  body = execNormalized.body;
  const thinking = thinkingMetadataFor(model);
  body = normalizeReasoningForModel(body, model, thinking);

  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, "oc3/0.1.0", requestId, sessionId, model.headers ?? {});
  if (credential.orgId) headers["x-org-id"] = credential.orgId;

  if (model.endpoint === "responses") {
    const upstreamBody = JSON.stringify({ ...body, ...withoutCredentialOptions(model.body), model: model.rawModelId, stream: true, store: false });
    let upstream: Response;
    let responsesAttempt = 0;
    while (true) {
      try {
        upstream = await fetch(endpointUrl(model.baseUrl, "responses", model.rawModelId), {
          method: "POST",
          headers,
          body: upstreamBody,
          signal: AbortSignal.timeout(600_000),
        });
      } catch (error) {
        if (responsesAttempt < 2 && isTransientNetworkError(error)) {
          await Bun.sleep(retryDelayMs(responsesAttempt++));
          continue;
        }
        throw error;
      }
      if (!upstream.ok && responsesAttempt < 2 && isTransientServerError(upstream.status, "")) {
        await Bun.sleep(retryDelayMs(responsesAttempt++));
        continue;
      }
      break;
    }
    if (!upstream.ok) return passthroughError(upstream);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }

  body = applyReasoningWire(body, model);
  if (searchBridgeNeeded(body, model)) {
    return await runSearchBridgeLoop(request, body, model, auth, sessionId);
  }
  const chatRequest = responsesRequestToChat(body, model);
  const chatUrl = endpointUrl(model.baseUrl, "chat-completions", model.rawModelId);
  let attempt = 0;
  let currentBody: Record<string, unknown> = chatRequest as unknown as Record<string, unknown>;
  while (true) {
    let upstream: Response;
    try {
      upstream = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(currentBody),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (attempt < 2 && isTransientNetworkError(error)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      throw error;
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      if (attempt < 4 && upstream.status === 429) {
        const retryAfter = Number(upstream.headers.get("retry-after"));
        await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : retryDelayMs(attempt++));
        continue;
      }
      if (attempt < 2 && isTransientServerError(upstream.status, detail)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      if (upstream.status === 400 && attempt < 2) {
        const patch = analyzeHttp400ForRetry(detail, currentBody);
        if (patch) {
          currentBody = patch.body;
          attempt += 1;
          continue;
        }
      }
      return json({ error: { message: `Upstream error ${upstream.status}: ${detail.slice(0, 2000)}` } }, upstream.status);
    }
    if (!upstream.body) return json({ error: { message: "Upstream returned no body" } }, 502);
    return streamChatToResponses(upstream.body, toolSchemas(body));
  }
}

async function passthroughError(upstream: Response): Promise<Response> {
  const text = await upstream.text().catch(() => "");
  return json({ error: { message: `Upstream error ${upstream.status}: ${text.slice(0, 2000)}` } }, upstream.status);
}

async function handleBridgedEndpoint(
  request: Request,
  body: Record<string, unknown>,
  model: Oc3Model,
  auth: OpenCodeAuth,
  sessionId: string,
): Promise<Response> {
  const credential = process.env.OC3_TEST_TOKEN
    ? { token: process.env.OC3_TEST_TOKEN, server: "", orgId: undefined, orgName: undefined }
    : await auth.getCredential();
  if (!credential.token) return json({ error: { message: "Not signed in. Run: oc3 login" } }, 401);
  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, "oc3/0.1.0", requestId, sessionId, model.headers ?? {});
  if (credential.orgId) headers["x-org-id"] = credential.orgId;
  const responseId = newId("resp");

  let upstreamBody: string;
  let url: string;
  let converter: { created(): unknown; ingest(event: Record<string, unknown>): unknown[]; finalize(stopReason: string | undefined): unknown[] };
  if (model.endpoint === "messages") {
    upstreamBody = JSON.stringify(anthropicRequestFromResponses(body, model));
    url = endpointUrl(model.baseUrl, "messages", model.rawModelId);
    const stream = new AnthropicStreamToResponses(responseId);
    converter = { created: () => stream.created(), ingest: (event) => stream.ingest(event), finalize: (reason) => stream.finalize(reason) };
  } else {
    upstreamBody = JSON.stringify(googleRequestFromResponses(body, model));
    url = endpointUrl(model.baseUrl, "google", model.rawModelId);
    const stream = new GoogleStreamToResponses(responseId);
    converter = { created: () => stream.created(), ingest: (event) => stream.ingest(event), finalize: (reason) => stream.finalize(reason) };
  }

  let attempt = 0;
  let upstream: Response;
  while (true) {
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: upstreamBody,
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (attempt < 2 && isTransientNetworkError(error)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      throw error;
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      if (attempt < 2 && isTransientServerError(upstream.status, detail)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      return json({ error: { message: `Upstream error ${upstream.status}: ${detail.slice(0, 2000)}` } }, upstream.status);
    }
    break;
  }
  if (!upstream.body) return json({ error: { message: "Upstream returned no body" } }, 502);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void (async () => {
    await writer.write(formatSseEvent(converter.created() as { event: string; data: Record<string, unknown> }));
    const reader = upstream!.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const block of parser.push(decoder.decode(value, { stream: true }))) {
          const data = parseSseData(`data: ${block.data}`);
          if (!data) continue;
          for (const event of converter.ingest(data)) {
            await writer.write(formatSseEvent(event as { event: string; data: Record<string, unknown> }));
          }
        }
      }
      for (const block of parser.finish()) {
        const data = parseSseData(`data: ${block.data}`);
        if (!data) continue;
        for (const event of converter.ingest(data)) {
          await writer.write(formatSseEvent(event as { event: string; data: Record<string, unknown> }));
        }
      }
      for (const event of converter.finalize(undefined)) {
        await writer.write(formatSseEvent(event as { event: string; data: Record<string, unknown> }));
      }
      await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "stream failed";
      await writer.write(formatSseEvent({ event: "error", data: { type: "error", message } }));
    } finally {
      await writer.close();
      reader.releaseLock();
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

const MAX_SEARCH_TURNS = 4;

// Chat-completions models cannot execute Codex's hosted web_search tool.
// Run an oc3-side loop: execute the search via Exa/Parallel MCP (mirroring
// opencode's client), append results to input, and re-run until the model
// answers without another search (bounded).
async function runSearchBridgeLoop(
  request: Request,
  initialBody: Record<string, unknown>,
  model: Oc3Model,
  auth: OpenCodeAuth,
  sessionId: string,
): Promise<Response> {
  let body = stripHostedSearchTool(initialBody).body;
  let lastTurn: { output: Array<Record<string, unknown>>; finishReason: string | undefined; usage: Record<string, unknown> | undefined } | undefined;
  for (let turn = 0; turn < 4; turn += 1) {
    const turnResult = await runOneChatTurn(body, model, auth, sessionId);
    if (typeof turnResult === "number") return json({ error: { message: `Upstream error ${turnResult}` } }, turnResult);
    lastTurn = turnResult;
    const searchCall = turnResult.output.find((item) => item.type === "function_call" && item.name === "web_search");
    if (!searchCall) break;
    let query = "";
    try {
      const parsed = JSON.parse(String(searchCall.arguments ?? "{}")) as Record<string, unknown>;
      query = typeof parsed.query === "string" ? parsed.query : "";
    } catch { /* malformed args: report empty-result tool output below */ }
    const output = query ? await executeWebSearch(query, sessionId) : "web_search failed: missing query argument";
    body = {
      ...body,
      input: [
        ...(Array.isArray(body.input) ? body.input : []),
        searchCall,
        { type: "function_call_output", call_id: searchCall.call_id, output },
      ],
    };
  }
  if (!lastTurn) return json({ error: { message: "Search loop produced no response" } }, 502);
  return synthesizeResponsesStream(lastTurn);
}

async function runOneChatTurn(
  body: Record<string, unknown>,
  model: Oc3Model,
  auth: OpenCodeAuth,
  sessionId: string,
): Promise<{ output: Array<Record<string, unknown>>; finishReason: string | undefined; usage: Record<string, unknown> | undefined } | number> {
  const credential = process.env.OC3_TEST_TOKEN
    ? { token: process.env.OC3_TEST_TOKEN, server: "", orgId: undefined, orgName: undefined }
    : await auth.getCredential();
  if (!credential.token) return 401;
  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, "oc3/0.1.0", requestId, sessionId, model.headers ?? {});
  if (credential.orgId) headers["x-org-id"] = credential.orgId;
  const chatRequest = responsesRequestToChat(body, model);
  let attempt = 0;
  let currentBody: Record<string, unknown> = chatRequest as unknown as Record<string, unknown>;
  while (true) {
    let upstream: Response;
    try {
      upstream = await fetch(endpointUrl(model.baseUrl, "chat-completions", model.rawModelId), {
        method: "POST",
        headers,
        body: JSON.stringify(currentBody),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (attempt < 2 && isTransientNetworkError(error)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      return 502;
    }
    if (!upstream.ok || !upstream.body) {
      const detail = !upstream.ok ? await upstream.text().catch(() => "") : "";
      if (attempt < 2 && isTransientServerError(upstream.status, detail)) {
        await Bun.sleep(retryDelayMs(attempt++));
        continue;
      }
      return upstream.status;
    }
    const responseId = newId("resp");
    const converter = new ChatStreamToResponses(responseId, toolSchemas(body));
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let finishReason: string | undefined;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const block of parser.push(decoder.decode(value, { stream: true }))) {
          const data = parseSseData(`data: ${block.data}`);
          if (!data) continue;
          if (data.finish_reason !== undefined || (Array.isArray(data.choices) && recordField((data.choices as unknown[])[0])?.finish_reason !== undefined)) {
            const choice = recordField((data.choices as unknown[])[0]);
            if (choice && typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          }
          converter.ingest(data);
        }
      }
      for (const block of parser.finish()) {
        const data = parseSseData(`data: ${block.data}`);
        if (data) converter.ingest(data);
      }
      const events = converter.finalize(finishReason);
      const completed = events.find((event) => event.event === "response.completed" || event.event === "response.incomplete");
      const response = completed?.data.response as Record<string, unknown> | undefined;
      const output = Array.isArray(response?.output) ? response?.output as Array<Record<string, unknown>> : [];
      return { output, finishReason, usage: response?.usage as Record<string, unknown> | undefined };
    } catch {
      return 502;
    }
  }
}

function synthesizeResponsesStream(turn: { output: Array<Record<string, unknown>>; finishReason: string | undefined; usage: Record<string, unknown> | undefined }): Response {
  const responseId = newId("resp");
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void (async () => {
    const send = async (event: { event: string; data: Record<string, unknown> }) => {
      await writer.write(formatSseEvent(event));
    };
    try {
      await send({ event: "response.created", data: { type: "response.created", response: { id: responseId } } });
      for (const item of turn.output) {
        if (item.type === "message") {
          const content = Array.isArray(item.content) ? item.content : [];
          const text = content.map((part) => typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "").join("");
          await send({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: item.id, role: "assistant", content: [] } } });
          if (text) await send({ event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text } });
          await send({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } });
        } else if (item.type === "function_call") {
          const index = turn.output.indexOf(item);
          await send({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } } });
          const args = typeof item.arguments === "string" ? item.arguments : "{}";
          await send({ event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: args } });
          await send({ event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: args } });
          await send({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: index, item } });
        }
      }
      const truncated = truncatedStopReason(turn.finishReason);
      if (truncated) {
        await send({
          event: "response.incomplete",
          data: { type: "response.incomplete", response: { id: responseId, output: turn.output, usage: turn.usage ?? zeroUsage(), incomplete_details: { reason: truncated === "max_output_tokens" ? "max_output_tokens" : "content_filter" } } },
        });
      } else {
        await send({ event: "response.completed", data: { type: "response.completed", response: { id: responseId, output: turn.output, usage: turn.usage ?? zeroUsage() } } });
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "stream failed";
      await send({ event: "error", data: { type: "error", message } });
    } finally {
      await writer.close();
    }
  })();
  return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

const NATIVE_CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";
const NATIVE_OPENAI_BASE = "https://api.openai.com/v1";

function nativeChatGptBase(): string {
  return process.env.OC3_CHATGPT_FALLBACK_URL ?? NATIVE_CHATGPT_BASE;
}

function nativeOpenAiBase(): string {
  return process.env.OC3_OPENAI_FALLBACK_URL ?? NATIVE_OPENAI_BASE;
}

// Unknown model: forward the Responses request to the native backends with the
// client's own auth headers (chatgpt-account-id => ChatGPT backend; otherwise
// OPENAI_API_KEY => api.openai.com). Mirrors ollama's route decision.
async function passthroughNative(request: Request, body: Record<string, unknown>): Promise<Response> {
  // Header contract mirrors ollama codex_desktop.go: ChatGPT-Account-ID marks a
  // ChatGPT-account session (forward client auth to the Codex backend); a Bearer
  // key that is not oc3's own marks an OpenAI API-key session.
  const chatGptAuth = request.headers.get("chatgpt-account-id");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  const apiKey = (bearer && bearer !== "oc3" ? bearer : undefined)
    ?? request.headers.get("x-openai-api-key")
    ?? process.env.OPENAI_API_KEY;
  const target = chatGptAuth ? nativeChatGptBase() : apiKey ? nativeOpenAiBase() : undefined;
  if (!target) {
    return json({ error: { message: `Unknown model ${JSON.stringify(String(body.model))} and no native backend credentials available. Run \`oc3 models --refresh\`.` } }, 404);
  }
  const forwardHeaders: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (chatGptAuth) {
    const clientAuth = request.headers.get("authorization");
    if (clientAuth) forwardHeaders["authorization"] = clientAuth;
    forwardHeaders["chatgpt-account-id"] = chatGptAuth;
  } else {
    forwardHeaders["authorization"] = `Bearer ${apiKey}`;
  }
  const upstream = await fetch(`${target}/responses`, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(body),
  });
  if (!upstream.ok) return passthroughError(upstream);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

function withoutCredentialOptions(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!body) return {};
  const stripped = Object.fromEntries(Object.entries(body).filter(([key]) => !/^(api_?key|base_?url|headers)$/i.test(key)));
  return stripped;
}

function pickDefaultModel(models: readonly Oc3Model[]): string | undefined {
  return models[0]?.id;
}

function toolSchemas(body: Record<string, unknown>): ReadonlyMap<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;
    if (record.type === "function" && typeof record.name === "string"
      && record.parameters && typeof record.parameters === "object" && !Array.isArray(record.parameters)) {
      schemas.set(record.name, record.parameters as Record<string, unknown>);
    }
  }
  return schemas;
}

async function streamChatToResponses(body: ReadableStream<Uint8Array>, schemas: ReadonlyMap<string, Record<string, unknown>> = new Map()): Promise<Response> {
  const responseId = newId("resp");
  const converter = new ChatStreamToResponses(responseId, schemas);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  void (async () => {
    await writer.write(formatSseEvent(converter.created()));
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const block of parser.push(decoder.decode(value, { stream: true }))) {
          const data = parseSseData(`data: ${block.data}`);
          if (!data) continue;
          for (const event of converter.ingest(data)) {
            await writer.write(formatSseEvent(event));
          }
        }
      }
      for (const block of parser.finish()) {
        const data = parseSseData(`data: ${block.data}`);
        if (!data) continue;
        for (const event of converter.ingest(data)) {
          await writer.write(formatSseEvent(event));
        }
      }
      for (const event of converter.finalize(undefined)) {
        await writer.write(formatSseEvent(event));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "stream failed";
      await writer.write(formatSseEvent({ event: "error", data: { type: "error", message } }));
    } finally {
      await writer.close();
      reader.releaseLock();
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

