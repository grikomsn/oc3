import { OpenCodeAuth } from "./auth";
import { availableModels } from "./console";
import { findModel, type Oc3Model } from "./models";
import { buildRequestHeaders, endpointUrl, newId, USER_AGENT } from "./protocol";
import { formatSseEvent, parseSseData, responsesRequestToChat, ChatStreamToResponses } from "./translate";

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
    : model.baseUrl.includes("127.0.0.1")
      ? { token: "test", server: "", orgId: undefined, orgName: undefined }
      : await auth.getCredential();
  if (!credential.token) {
    return json({ error: { message: "No credentials for this model provider" } }, 401);
  }

  const requestId = newId("req");
  const headers = buildRequestHeaders(model.endpoint, credential.token, "oc3/0.1.0", requestId, sessionId, model.headers ?? {});
  if (credential.orgId) headers["x-org-id"] = credential.orgId;

  if (model.endpoint === "responses") {
    const upstreamBody = JSON.stringify({ ...body, ...(model.body ?? {}), model: model.rawModelId, stream: true, store: false });
    const upstream = await fetch(endpointUrl(model.baseUrl, "responses", model.rawModelId), {
      method: "POST",
      headers,
      body: upstreamBody,
    });
    if (!upstream.ok) return passthroughError(upstream);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }

  const chatRequest = responsesRequestToChat(body, model);
  const upstream = await fetch(endpointUrl(model.baseUrl, "chat-completions", model.rawModelId), {
    method: "POST",
    headers,
    body: JSON.stringify(chatRequest),
  });
  if (!upstream.ok) return passthroughError(upstream);
  if (!upstream.body) return json({ error: { message: "Upstream returned no body" } }, 502);
  return streamChatToResponses(upstream.body);
}

async function passthroughError(upstream: Response): Promise<Response> {
  const text = await upstream.text().catch(() => "");
  return json({ error: { message: `Upstream error ${upstream.status}: ${text.slice(0, 2000)}` } }, upstream.status);
}

async function streamChatToResponses(body: ReadableStream<Uint8Array>): Promise<Response> {
  const responseId = newId("resp");
  const converter = new ChatStreamToResponses(responseId);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  void (async () => {
    await writer.write(formatSseEvent(converter.created()));
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = parseSseData(line.trim());
          if (!data) continue;
          for (const event of converter.ingest(data)) {
            await writer.write(formatSseEvent(event));
          }
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

