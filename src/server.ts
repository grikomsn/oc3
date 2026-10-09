import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { OpenCodeAuth } from "./auth";
import { availableModels } from "./console";
import { findModel, isGatewayProvider, modelGroup, type Oc3Model } from "./models";
import { buildRequestHeaders, endpointUrl, nativeChatGptBase, nativeOpenAiBase, newId, userAgent } from "./protocol";
import { credentialErrorHint, credentialForModel } from "./credentials";
import { gatewayChatTemplateArgs, gatewayResponsesExtras } from "./gateway";
import { ChatStreamToResponses, formatSseEvent, parseSseData, responsesRequestToChat, type ChatCompletionRequest, type EmittedEvent } from "./translate";
import { analyzeHttp400ForRetry, isTransientNetworkError, isTransientServerError, retryDelayMs } from "./retry";
import { SseParser } from "./sse-parser";
import { applyReasoningWire, extractTurnMetadata, normalizeFullAccessExecTool, normalizeInputItems, normalizeReasoningForModel, resolveAutoReview, sanitizeCrossProviderHistory, TurnModelCache } from "./desktop-normalize";
import { thinkingMetadataFor } from "./routing-catalog";
import { executeWebSearch, searchBridgeNeeded, stripHostedSearchTool } from "./web-search";
import { anthropicRequestFromResponses, AnthropicStreamToResponses } from "./anthropic-bridge";
import { googleRequestFromResponses, GoogleStreamToResponses } from "./google-bridge";
import { asRecord, zeroUsage } from "./bridge-common";


/** One settled /responses request, kept in a bounded ring for the TUI. */
export interface RequestRecord {
  /** Epoch ms when the request arrived. */
  at: number;
  /** Requested model slug (resolved oc3 model id when known). */
  model: string;
  /** HTTP status returned to the client. */
  status: number;
  /** Handler wall time in ms. */
  ms: number;
}

export interface ServerHandle {
  port: number;
  stop(): void;
  requestCount(): number;
  recentRequests(): RequestRecord[];
}

export function startServer(options: { port: number; auth: OpenCodeAuth }): Promise<ServerHandle> {
  const auth = options.auth;
  let requests = 0;
  const recentRequests: RequestRecord[] = [];
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
          return json({ ok: true, pid: process.pid, models: models.length, signedIn: auth.isSignedIn(), requests });
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
          return await handleResponses(request, auth, sessionId, turnModels, (record) => {
            recentRequests.push(record);
            if (recentRequests.length > 50) recentRequests.shift();
          });
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
    recentRequests: () => [...recentRequests],
  });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;
const MAX_UPSTREAM_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_SEARCH_TURNS = 4;
const EVENT_STREAM_HEADERS: Record<string, string> = { "Content-Type": "text/event-stream", "Cache-Control": "no-store" };

async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  const parsed = asRecord(JSON.parse(new TextDecoder().decode(decodeRequestBody(raw, encoding))));
  if (!parsed) throw new Error("request body must be a JSON object");
  return parsed;
}

function decodeRequestBody(raw: Uint8Array, encoding: string): Uint8Array {
  const limits = { maxOutputLength: MAX_BODY_BYTES };
  try {
    if (!encoding || encoding === "identity") return raw;
    if (encoding === "zstd") return zstdDecompressSync(raw, limits);
    if (encoding === "gzip") return gunzipSync(raw, limits);
    if (encoding === "deflate") return inflateSync(raw, limits);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`decompressed request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    throw error;
  }
  throw new Error(`Unsupported Content-Encoding: ${encoding}`);
}

async function handleResponses(
  request: Request,
  auth: OpenCodeAuth,
  sessionId: string,
  turnModels: TurnModelCache,
  record?: (entry: RequestRecord) => void,
): Promise<Response> {
  const startedAt = Date.now();
  let slug = "";
  const response = await handleResponsesInner(request, auth, sessionId, turnModels, (model) => {
    slug = model;
  });
  record?.({ at: startedAt, model: slug, status: response.status, ms: Date.now() - startedAt });
  return response;
}

async function handleResponsesInner(
  request: Request,
  auth: OpenCodeAuth,
  sessionId: string,
  turnModels: TurnModelCache,
  setSlug: (model: string) => void,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseRequestBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON body";
    return json({ error: { message } }, 400);
  }
  const requestedModel = typeof body.model === "string" ? body.model : "";
  setSlug(requestedModel);
  const models = availableModels();
  let model = findModel(models, requestedModel);
  if (!model) {
    const autoReview = resolveAutoReview(requestedModel, body, turnModels, pickDefaultModel(models), pickDefaultGroup(models));
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
  setSlug(model.id);
  if (model.providerId === "chatgpt") {
    // Native ChatGPT models use the client's own Codex account session.
    const chatGptAuth = request.headers.get("chatgpt-account-id");
    const clientAuth = request.headers.get("authorization");
    if (!chatGptAuth || !clientAuth) {
      return json({ error: { message: "chatgpt/* models need the Codex ChatGPT account session (chatgpt-account-id header)." } }, 401);
    }
    return await passthroughNative(request, body, nativeChatGptBase());
  }
  if (model.endpoint === "chat-completions" && body.stream !== true) {
    return json({ error: { message: "oc3 only proxies streaming requests (stream: true)" } }, 400);
  }

  const credential = await credentialForModel(model, auth);
  if (!credential) {
    return json({ error: { message: credentialErrorHint(model) } }, 401);
  }

  body = normalizeInputItems(body).body;
  const sandboxMode = typeof body.sandbox_mode === "string" ? body.sandbox_mode : undefined;
  body = normalizeFullAccessExecTool(body, sandboxMode).body;
  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, userAgent(), requestId, sessionId, model.headers ?? {});
  applyOrgHeaders(headers, credential.orgId);

  const { turnId, parentTurnId } = extractTurnMetadata(body);
  turnModels.remember(turnId, requestedModel || model.id, modelGroup(model));
  const previousGroup = turnModels.lookup(parentTurnId)?.group;
  body = sanitizeCrossProviderHistory(body, previousGroup, modelGroup(model)).body;

  if (model.endpoint === "messages" || model.endpoint === "google") {
    return await handleBridgedEndpoint(body, model, headers, request.signal);
  }

  body = normalizeReasoningForModel(body, model, thinkingMetadataFor(model));
  if (model.endpoint === "responses") {
    const gatewayExtras = isGatewayProvider(model.providerId) ? gatewayResponsesExtras(body, sessionId) : {};
    const upstreamBody = { ...body, ...withoutCredentialOptions(model.body), ...gatewayExtras, model: model.rawModelId, stream: true, store: false };
    const upstream = await fetchUpstream(endpointUrl(model.baseUrl, "responses", model.rawModelId), { headers, body: upstreamBody, signal: request.signal });
    if (!upstream.ok) return gatewayErrorResponse(model, upstream.status, upstream.detail);
    return new Response(upstream.response.body, { status: upstream.response.status, headers: EVENT_STREAM_HEADERS });
  }

  body = applyReasoningWire(body, model);
  if (searchBridgeNeeded(body, model)) {
    return await runSearchBridgeLoop(body, model, auth, sessionId, request.signal);
  }
  const upstream = await fetchUpstream(endpointUrl(model.baseUrl, "chat-completions", model.rawModelId), {
    headers,
    body: chatUpstreamBody(body, model),
    signal: request.signal,
  }, CHAT_UPSTREAM_POLICY);
  if (!upstream.ok) return gatewayErrorResponse(model, upstream.status, upstream.detail);
  if (!upstream.response.body) return json({ error: { message: "Upstream returned no body" } }, 502);
  return streamChatToResponses(upstream.response.body, toolSchemas(body));
}

// --- upstream fetch: one retry policy for every OpenCode-bound request ---

interface UpstreamInit {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

interface UpstreamPolicy {
  /** Rewrites the body after a 400; returning undefined keeps the 400. */
  patchBody?: (detail: string, body: Record<string, unknown>) => Record<string, unknown> | undefined;
}

type UpstreamOutcome = { ok: true; response: Response } | { ok: false; status: number; detail: string };

// Chat-completions only: a 400 that names a rejected field is retried once
// without it (retry.ts decides which fields are safe to drop).
const CHAT_UPSTREAM_POLICY: UpstreamPolicy = {
  patchBody: (detail, body) => analyzeHttp400ForRetry(detail, body)?.body,
};

/**
 * Posts to an upstream with one retry policy: transient network errors, 429
 * (honoring Retry-After when present), and transient 5xx. Every retry counts
 * against MAX_UPSTREAM_RETRIES. A failed response body is consumed before retrying.
 */
async function fetchUpstream(url: string, init: UpstreamInit, policy: UpstreamPolicy = {}): Promise<UpstreamOutcome> {
  let body = init.body;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: init.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), init.signal]),
      });
    } catch (error) {
      if (attempt < MAX_UPSTREAM_RETRIES && isTransientNetworkError(error)) {
        await Bun.sleep(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    if (response.ok) return { ok: true, response };
    const detail = await response.text().catch(() => "");
    if (attempt < MAX_UPSTREAM_RETRIES) {
      if (response.status === 429) {
        await Bun.sleep(retryAfterMs(response.headers.get("retry-after")) ?? retryDelayMs(attempt));
        continue;
      }
      if (isTransientServerError(response.status, detail)) {
        await Bun.sleep(retryDelayMs(attempt));
        continue;
      }
      const patched = response.status === 400 ? policy.patchBody?.(detail, body) : undefined;
      if (patched) {
        body = patched;
        continue;
      }
    }
    return { ok: false, status: response.status, detail };
  }
}

/** Retry-After as delta-seconds or an HTTP-date, capped at MAX_RETRY_AFTER_MS. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return undefined;
}

async function passthroughError(upstream: Response): Promise<Response> {
  const text = await upstream.text().catch(() => "");
  return json({ error: { message: `Upstream error ${upstream.status}: ${text.slice(0, 2000)}` } }, upstream.status);
}


interface BridgedConverter {
  created(): EmittedEvent;
  ingest(event: Record<string, unknown>): EmittedEvent[];
  finalize(stopReason: string | undefined): EmittedEvent[];
}

async function handleBridgedEndpoint(
  body: Record<string, unknown>,
  model: Oc3Model,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const responseId = newId("resp");
  const isAnthropic = model.endpoint === "messages";
  const payload = isAnthropic ? anthropicRequestFromResponses(body, model) : googleRequestFromResponses(body, model);
  const url = endpointUrl(model.baseUrl, isAnthropic ? "messages" : "google", model.rawModelId);
  const converter: BridgedConverter = isAnthropic ? new AnthropicStreamToResponses(responseId) : new GoogleStreamToResponses(responseId);

  const upstream = await fetchUpstream(url, { headers, body: payload, signal });
  if (!upstream.ok) return gatewayErrorResponse(model, upstream.status, upstream.detail);
  const stream = upstream.response.body;
  if (!stream) return json({ error: { message: "Upstream returned no body" } }, 502);
  return sseResponse(async (write) => {
    await write(converter.created());
    await pumpSse(stream, async (data) => {
      for (const event of converter.ingest(data)) await write(event);
    });
    for (const event of converter.finalize(undefined)) await write(event);
  });
}

// Chat-completions models cannot execute Codex's hosted web_search tool.
// Run an oc3-side loop: execute each search via Exa/Parallel MCP (mirroring
// opencode's client), append results to input, and re-run until the model
// answers without another search (bounded by MAX_SEARCH_TURNS).
async function runSearchBridgeLoop(
  initialBody: Record<string, unknown>,
  model: Oc3Model,
  auth: OpenCodeAuth,
  sessionId: string,
  signal: AbortSignal,
): Promise<Response> {
  let body = stripHostedSearchTool(initialBody).body;
  const reasoning: EmittedEvent[] = [];
  for (let turnNumber = 1; ; turnNumber += 1) {
    const turn = await runOneChatTurn(body, model, auth, sessionId, signal);
    if (turn instanceof Response) return turn;
    reasoning.push(...turn.reasoning);
    const searchCalls = turn.output.filter(isWebSearchCall);
    if (!searchCalls.length) return synthesizeResponsesStream({ ...turn, reasoning });
    if (turnNumber >= MAX_SEARCH_TURNS) {
      return synthesizeResponsesStream({ ...turn, output: [], reasoning }, "web_search_round_limit");
    }
    const outputs = await Promise.all(searchCalls.map((call) => answerWebSearch(call, sessionId)));
    const answers = searchCalls.flatMap((call, index) => [call, { type: "function_call_output", call_id: call.call_id, output: outputs[index] }]);
    body = { ...body, input: [...(Array.isArray(body.input) ? body.input : []), ...answers] };
  }
}

function isWebSearchCall(item: Record<string, unknown>): boolean {
  return item.type === "function_call" && item.name === "web_search";
}

async function answerWebSearch(call: Record<string, unknown>, sessionId: string): Promise<string> {
  let query = "";
  try {
    const parsed = JSON.parse(String(call.arguments ?? "{}")) as Record<string, unknown>;
    query = typeof parsed.query === "string" ? parsed.query : "";
  } catch { /* malformed args: reported as a failed search below */ }
  if (!query) return "web_search failed: missing query argument";
  try {
    return await executeWebSearch(query, sessionId);
  } catch (error) {
    return `web search failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

interface SearchTurn {
  output: Array<Record<string, unknown>>;
  incompleteReason: string | undefined;
  usage: Record<string, unknown> | undefined;
  reasoning: EmittedEvent[];
}

async function runOneChatTurn(
  body: Record<string, unknown>,
  model: Oc3Model,
  auth: OpenCodeAuth,
  sessionId: string,
  signal: AbortSignal,
): Promise<SearchTurn | Response> {
  const credential = await credentialForModel(model, auth);
  if (!credential) return json({ error: { message: credentialErrorHint(model) } }, 401);
  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, userAgent(), requestId, sessionId, model.headers ?? {});
  applyOrgHeaders(headers, credential.orgId);
  try {
    const upstream = await fetchUpstream(endpointUrl(model.baseUrl, "chat-completions", model.rawModelId), {
      headers,
      body: chatUpstreamBody(body, model),
      signal,
    }, CHAT_UPSTREAM_POLICY);
    if (!upstream.ok) return gatewayErrorResponse(model, upstream.status, upstream.detail);
    const stream = upstream.response.body;
    if (!stream) return gatewayErrorResponse(model, 502, "Upstream returned no body");
    const converter = new ChatStreamToResponses(newId("resp"), toolSchemas(body));
    const reasoning: EmittedEvent[] = [];
    await pumpSse(stream, (data) => {
      for (const event of converter.ingest(data)) {
        if (event.event === "response.reasoning_summary_text.delta") reasoning.push(event);
      }
    });
    const events = converter.finalize(undefined);
    const failure = events.find((event) => event.event === "error");
    if (failure) return gatewayErrorResponse(model, 502, String(failure.data.message));
    const completed = events.find((event) => event.event === "response.completed" || event.event === "response.incomplete");
    const response = completed?.data.response as Record<string, unknown> | undefined;
    const output = Array.isArray(response?.output) ? response?.output as Array<Record<string, unknown>> : [];
    const incompleteReason = completed?.event === "response.incomplete"
      ? String(asRecord(response?.incomplete_details)?.reason ?? "content_filter")
      : undefined;
    return { output, incompleteReason, usage: response?.usage as Record<string, unknown> | undefined, reasoning };
  } catch (error) {
    return gatewayErrorResponse(model, 502, error instanceof Error ? error.message : "stream failed");
  }
}

function synthesizeResponsesStream(turn: SearchTurn, incompleteReason?: string): Response {
  const responseId = newId("resp");
  return sseResponse(async (write) => {
    await write({ event: "response.created", data: { type: "response.created", response: { id: responseId } } });
    for (const event of turn.reasoning) await write(event);
    if (incompleteReason) {
      await write({
        event: "response.incomplete",
        data: { type: "response.incomplete", response: { id: responseId, output: [], usage: turn.usage ?? zeroUsage(), incomplete_details: { reason: incompleteReason } } },
      });
      return;
    }
    for (const item of turn.output) {
      if (item.type === "message") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((part) => typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "").join("");
        await write({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: item.id, role: "assistant", content: [] } } });
        if (text) await write({ event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text } });
        await write({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } });
      } else if (item.type === "function_call") {
        const index = turn.output.indexOf(item);
        await write({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } } });
        const args = typeof item.arguments === "string" ? item.arguments : "{}";
        await write({ event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: args } });
        await write({ event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: args } });
        await write({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: index, item } });
      }
    }
    if (turn.incompleteReason) {
      await write({
        event: "response.incomplete",
        data: { type: "response.incomplete", response: { id: responseId, output: turn.output, usage: turn.usage ?? zeroUsage(), incomplete_details: { reason: turn.incompleteReason } } },
      });
    } else {
      await write({ event: "response.completed", data: { type: "response.completed", response: { id: responseId, output: turn.output, usage: turn.usage ?? zeroUsage() } } });
    }
  });
}

// Unknown model: forward the Responses request to the native backends with the
// client's own auth headers (chatgpt-account-id => ChatGPT backend; otherwise
// OPENAI_API_KEY => api.openai.com). Mirrors ollama's route decision.
async function passthroughNative(request: Request, body: Record<string, unknown>, forcedBase?: string): Promise<Response> {
  // Header contract mirrors ollama codex_desktop.go: ChatGPT-Account-ID marks a
  // ChatGPT-account session (forward client auth to the Codex backend); a Bearer
  // key that is not oc3's own marks an OpenAI API-key session.
  const chatGptAuth = request.headers.get("chatgpt-account-id");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  const apiKey = (bearer && bearer !== "oc3" ? bearer : undefined)
    ?? request.headers.get("x-openai-api-key")
    ?? process.env.OPENAI_API_KEY;
  const target = forcedBase ?? (chatGptAuth ? nativeChatGptBase() : apiKey ? nativeOpenAiBase() : undefined);
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
    signal: request.signal,
  });
  if (!upstream.ok) return passthroughError(upstream);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: EVENT_STREAM_HEADERS,
  });
}

// Console references disagree on the inference org header (copilot-chat sends
// x-org-id, pi-provider sends x-opencode-org-id); send both until verified live.
function gatewayErrorResponse(model: Oc3Model, status: number, detail: string): Response {
  const gateway = isGatewayProvider(model.providerId);
  const message = gateway && status === 429
    ? `Upstream error ${status}: ${detail.slice(0, 2000)} — OpenCode gateway rate limit or subscription quota reached; run \`oc3 usage\` for Go quota (keys: https://opencode.ai/auth)`
    : `Upstream error ${status}: ${detail.slice(0, 2000)}`;
  return json({ error: { message } }, status);
}

function applyOrgHeaders(headers: Record<string, string>, orgId: string | undefined): void {
  if (!orgId) return;
  headers["x-org-id"] = orgId;
  headers["x-opencode-org-id"] = orgId;
}

function withoutCredentialOptions(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!body) return {};
  const stripped = Object.fromEntries(Object.entries(body).filter(([key]) => !/^(api_?key|base_?url|headers)$/i.test(key)));
  return stripped;
}

function pickDefaultModel(models: readonly Oc3Model[]): string | undefined {
  return models[0]?.id;
}

function pickDefaultGroup(models: readonly Oc3Model[]): string | undefined {
  return models[0] ? modelGroup(models[0]) : undefined;
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

// The chat-completions wire body: the translated request plus the reasoning and
// gateway template fields that are added as loose keys after translation.
type ChatUpstreamRequest = ChatCompletionRequest & { parallel_tool_calls?: boolean; reasoning_effort?: string; [key: string]: unknown };

function chatUpstreamBody(body: Record<string, unknown>, model: Oc3Model): ChatUpstreamRequest {
  return { ...responsesRequestToChat(body, model), ...gatewayChatTemplateArgs(model) };
}

function streamChatToResponses(body: ReadableStream<Uint8Array>, schemas: ReadonlyMap<string, Record<string, unknown>> = new Map()): Response {
  const converter = new ChatStreamToResponses(newId("resp"), schemas);
  return sseResponse(async (write) => {
    await write(converter.created());
    await pumpSse(body, async (data) => {
      for (const event of converter.ingest(data)) await write(event);
    });
    for (const event of converter.finalize(undefined)) await write(event);
  });
}

/**
 * Reads an upstream SSE body and hands each parsed data payload to onData. The
 * upstream reader is cancelled on any failure, including a throw from onData
 * (a client write failure), so the upstream connection is never left open.
 */
async function pumpSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let drained = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      for (const block of parser.push(decoder.decode(value, { stream: true }))) {
        const data = parseSseData(`data: ${block.data}`);
        if (data) await onData(data);
      }
    }
    for (const block of parser.finish()) {
      const data = parseSseData(`data: ${block.data}`);
      if (data) await onData(data);
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type SseWriter = (event: EmittedEvent) => Promise<void>;

/**
 * Runs produce in the background and streams its events as SSE, followed by
 * [DONE]. A failure becomes a final error event. Client disconnects surface as
 * failed writes and end the background task quietly.
 */
function sseResponse(produce: (write: SseWriter) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write: SseWriter = (event) => writer.write(formatSseEvent(event));
  void (async () => {
    try {
      await produce(write);
      await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "stream failed";
      await write({ event: "error", data: { type: "error", message } }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })().catch(() => {});
  return new Response(readable, { status: 200, headers: EVENT_STREAM_HEADERS });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
