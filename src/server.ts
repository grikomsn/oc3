import { OpenCodeAuth } from "./auth";
import { availableModels } from "./console";
import { findModel, type Oc3Model } from "./models";
import { buildRequestHeaders, endpointUrl, newId, USER_AGENT } from "./protocol";
import { formatSseEvent, parseSseData, responsesRequestToChat, ChatStreamToResponses } from "./translate";
import { analyzeHttp400ForRetry, isTransientNetworkError, isTransientServerError, retryDelayMs } from "./retry";
import { SseParser } from "./sse-parser";

export interface ServerHandle {
  port: number;
  stop(): void;
  requestCount(): number;
}

export function startServer(options: { port: number; auth: OpenCodeAuth }): Promise<ServerHandle> {
  const auth = options.auth;
  let requests = 0;
  const sessionId = newId("sess");
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
        const responsesMatch = request.method === "POST" && (path === "/responses" || path === "/v1/responses" || path === "/backend-api/codex/responses");
        if (responsesMatch) {
          requests += 1;
          return await handleResponses(request, auth, sessionId);
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

async function handleResponses(request: Request, auth: OpenCodeAuth, sessionId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const models = availableModels();
  const model = findModel(models, requestedModel);
  if (!model) {
    return json({
      error: {
        message: `Unknown model ${JSON.stringify(requestedModel)}. Run \`oc3 models\` to refresh the catalog.`,
      },
    }, 404);
  }
  if (model.endpoint === "messages" || model.endpoint === "google") {
    return json({
      error: { message: `Model ${model.id} uses the ${model.endpoint} endpoint, which oc3 does not bridge yet.` },
    }, 501);
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

  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, "oc3/0.1.0", requestId, sessionId, model.headers ?? {});
  if (credential.orgId) headers["x-org-id"] = credential.orgId;

  if (model.endpoint === "responses") {
    const upstreamBody = JSON.stringify({ ...body, ...(model.body ?? {}), model: model.rawModelId, stream: true, store: false });
    let upstream: Response;
    let responsesAttempt = 0;
    while (true) {
      try {
        upstream = await fetch(endpointUrl(model.baseUrl, "responses", model.rawModelId), {
          method: "POST",
          headers,
          body: upstreamBody,
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

  const chatRequest = responsesRequestToChat(body, model);
  const chatUrl = endpointUrl(model.baseUrl, "chat-completions", model.rawModelId);
  let attempt = 0;
  let currentBody: Record<string, unknown> = chatRequest as unknown as Record<string, unknown>;
  while (true) {
    let upstream: Response;
    try {
      upstream = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(currentBody) });
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

