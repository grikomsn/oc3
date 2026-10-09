import { describe, expect, test } from "bun:test";
import { analyzeHttp400ForRetry, isTransientNetworkError, isTransientServerError, retryDelayMs } from "../src/retry";

describe("retry analysis", () => {
  test("strips fields the upstream rejected", () => {
    const body = { model: "m", temperature: 0.7 };
    const patch = analyzeHttp400ForRetry("invalid temperature value", body);
    expect(patch?.reason).toContain("temperature");
    expect(patch?.body).toEqual({ model: "m" });
  });

  test("patches context overflow by reducing max_tokens", () => {
    const patch = analyzeHttp400ForRetry(
      "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      { max_tokens: 10000 },
    );
    expect(patch?.body.max_tokens).toBeLessThan(10000);
  });

  test("classifies transient failures", () => {
    expect(isTransientServerError(503, "")).toBe(true);
    expect(isTransientServerError(400, "")).toBe(false);
    expect(retryDelayMs(0)).toBe(250);
    expect(retryDelayMs(3)).toBe(2000);
  });
});

describe("isTransientServerError", () => {
  test("treats gateway statuses as transient", () => {
    expect([502, 503, 504].map((status) => isTransientServerError(status, ""))).toEqual([true, true, true]);
  });

  test("treats a 500 only when the detail names a transient router or internal error", () => {
    expect(isTransientServerError(500, "upstream Router-Unavailable")).toBe(true);
    expect(isTransientServerError(500, "Router_Unavailable")).toBe(true);
    expect(isTransientServerError(500, "error: Internal server error.")).toBe(true);
    expect(isTransientServerError(500, "")).toBe(false);
    expect(isTransientServerError(500, "invalid api key")).toBe(false);
    expect(isTransientServerError(400, "Router Unavailable")).toBe(false);
  });
});

describe("isTransientNetworkError", () => {
  test("classifies socket and fetch failures as transient", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientNetworkError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientNetworkError(new Error("socket hang up"))).toBe(true);
  });

  test("looks through nested and string causes", () => {
    expect(isTransientNetworkError(new Error("request failed", {
      cause: new Error("getaddrinfo EAI_AGAIN api.example.test"),
    }))).toBe(true);
    expect(isTransientNetworkError(new Error("request failed", { cause: "UND_ERR_SOCKET" }))).toBe(true);
  });

  test("ignores aborts, non-errors, and unrelated failures", () => {
    const abort = new Error("fetch failed");
    abort.name = "AbortError";
    expect(isTransientNetworkError(abort)).toBe(false);
    expect(isTransientNetworkError("fetch failed")).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(new Error("invalid JSON in response"))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  test("doubles from 250ms and caps at 2s", () => {
    expect([0, 1, 2, 3, 4, 10].map((attempt) => retryDelayMs(attempt))).toEqual([250, 500, 1000, 2000, 2000, 2000]);
  });

  test("treats negative attempts as the first attempt", () => {
    expect(retryDelayMs(-1)).toBe(250);
  });
});
