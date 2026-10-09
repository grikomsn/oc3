import { describe, expect, test } from "bun:test";
import { buildAuthHeaders, buildRequestHeaders, endpointUrl, providerMode } from "../src/protocol";

const ACCEPT = "text/event-stream, application/json";

function headerNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).map((name) => name.toLowerCase());
}

describe("auth headers", () => {
  test("responses and chat-completions send a Bearer token", () => {
    expect(buildAuthHeaders("responses", "tok")).toEqual({ Authorization: "Bearer tok" });
    expect(buildAuthHeaders("chat-completions", "tok")).toEqual({ Authorization: "Bearer tok" });
  });

  test("messages sends x-api-key with the pinned anthropic version", () => {
    expect(buildAuthHeaders("messages", "tok")).toEqual({ "x-api-key": "tok", "anthropic-version": "2023-06-01" });
  });

  test("google sends x-goog-api-key", () => {
    expect(buildAuthHeaders("google", "tok")).toEqual({ "x-goog-api-key": "tok" });
  });
});

describe("request headers", () => {
  test("responses endpoint carries Bearer auth and the oc3 client identity", () => {
    expect(buildRequestHeaders("responses", "tok", "oc3/test", "req_1", "sess_1")).toEqual({
      Authorization: "Bearer tok",
      Accept: ACCEPT,
      "Content-Type": "application/json",
      "User-Agent": "oc3/test",
      "x-opencode-client": "oc3",
      "x-opencode-project": "oc3",
      "x-opencode-request": "req_1",
      "x-opencode-session": "sess_1",
    });
  });

  test("messages endpoint uses x-api-key and no Authorization", () => {
    const headers = buildRequestHeaders("messages", "tok", "oc3/test", "req_1", "sess_1");
    expect(headers["x-api-key"]).toBe("tok");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers.Accept).toBe(ACCEPT);
  });

  test("google endpoint uses x-goog-api-key and no Authorization", () => {
    const headers = buildRequestHeaders("google", "tok", "oc3/test", "req_1", "sess_1");
    expect(headers["x-goog-api-key"]).toBe("tok");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers["x-opencode-session"]).toBe("sess_1");
  });

  test("catalog-supplied credential headers are stripped before the injected token", () => {
    const headers = buildRequestHeaders("messages", "real-token", "oc3/test", "req_1", "sess_1", {
      authorization: "Bearer catalog",
      "X-Api-Key": "catalog-key",
      "X-Goog-Api-Key": "catalog-goog",
      Cookie: "session=catalog",
      "x-custom-trace": "kept",
    });
    expect(headers["x-api-key"]).toBe("real-token");
    expect(headerNames(headers).filter((name) => name === "x-api-key")).toHaveLength(1);
    for (const forbidden of ["authorization", "x-goog-api-key", "cookie"]) {
      expect(headerNames(headers)).not.toContain(forbidden);
    }
    expect(headers["x-custom-trace"]).toBe("kept");
  });

  test("a catalog Authorization header cannot sit beside the Bearer token", () => {
    const headers = buildRequestHeaders("responses", "real-token", "oc3/test", "req_1", "sess_1", {
      Authorization: "Bearer catalog",
    });
    expect(headers.Authorization).toBe("Bearer real-token");
    expect(headerNames(headers).filter((name) => name === "authorization")).toHaveLength(1);
  });
});

describe("endpoint urls", () => {
  test("each endpoint kind maps onto its upstream path", () => {
    const base = "https://gateway.test/zen/v1/";
    expect(endpointUrl(base, "responses", "gpt-5")).toBe("https://gateway.test/zen/v1/responses");
    expect(endpointUrl(base, "messages", "claude-sonnet-5")).toBe("https://gateway.test/zen/v1/messages");
    expect(endpointUrl(base, "chat-completions", "kimi-k2")).toBe("https://gateway.test/zen/v1/chat/completions");
  });

  test("google streams the encoded model path with SSE framing", () => {
    expect(endpointUrl("https://gateway.test/zen/v1/", "google", "gemini-3-flash")).toBe(
      "https://gateway.test/zen/v1/gemini-3-flash:streamGenerateContent?alt=sse",
    );
    expect(endpointUrl("https://gateway.test/zen/v1", "google", "models/gemini")).toBe(
      "https://gateway.test/zen/v1/models%2Fgemini:streamGenerateContent?alt=sse",
    );
  });
});

describe("provider modes", () => {
  test("gateway provider ids map to their mode slot", () => {
    expect(providerMode("opencode")).toBe("console");
    expect(providerMode("opencode-go")).toBe("go");
  });

  test("other provider ids have no gateway mode", () => {
    expect(providerMode("openai")).toBeUndefined();
    expect(providerMode("chatgpt")).toBeUndefined();
    expect(providerMode("console-org")).toBeUndefined();
  });
});
