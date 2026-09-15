import { describe, expect, test } from "bun:test";
import { coerceToolArguments, isCompletePatchEnvelope, normalizeApplyPatchDelimiters } from "../src/tool-args-repair";
import { analyzeHttp400ForRetry, isTransientServerError, retryDelayMs } from "../src/retry";
import { SseParser } from "../src/sse-parser";

describe("coerceToolArguments", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      name: { type: "string" },
      nested: { $ref: "#/$defs/inner" },
    },
    $defs: { inner: { type: "object", properties: { depth: { type: "integer" } } } },
  };

  test("repairs integral floats in integer fields", () => {
    expect(coerceToolArguments('{"count":120000.0,"name":"x"}', schema, "shell"))
      .toBe('{"count":120000,"name":"x"}');
  });

  test("repairs bare integers in string-declared fields", () => {
    expect(coerceToolArguments('{"name":42}', schema, "shell")).toBe('{"name":"42"}');
  });

  test("leaves genuine disagreements alone", () => {
    expect(coerceToolArguments('{"count":1.5}', schema, "shell")).toBe('{"count":1.5}');
    expect(coerceToolArguments('{"name":1.5}', schema, "shell")).toBe('{"name":1.5}');
    expect(coerceToolArguments('{"count":12345678901234567890.0}', schema, "shell"))
      .toBe('{"count":12345678901234567890.0}');
  });

  test("resolves $ref schemas through composition", () => {
    expect(coerceToolArguments('{"nested":{"depth":3.0}}', schema, "shell"))
      .toBe('{"nested":{"depth":3}}');
    const union = { type: "object", properties: { value: { anyOf: [{ type: "integer" }, { type: "string" }] } } };
    expect(coerceToolArguments('{"value":2.0}', union, "shell")).toBe('{"value":2}');
    expect(coerceToolArguments('{"value":2.5}', union, "shell")).toBe('{"value":2.5}');
  });

  test("allowlisted u64 fields repair on number-declared schemas", () => {
    expect(coerceToolArguments('{"timeout_ms":5.0}', { type: "object", properties: { timeout_ms: { type: "number" } } }, "shell"))
      .toBe('{"timeout_ms":5}');
    expect(coerceToolArguments('{"yield_time_ms":5.0}', { type: "object", properties: { yield_time_ms: { type: "number" } } }, "wait"))
      .toBe('{"yield_time_ms":5}');
    expect(coerceToolArguments('{"yield_time_ms":5.0}', { type: "object", properties: { yield_time_ms: { type: "number" } } }, "other-tool"))
      .toBe('{"yield_time_ms":5.0}');
  });

  test("returns original bytes when no repair is needed", () => {
    expect(coerceToolArguments('{"count":5}', schema, "shell")).toBe('{"count":5}');
    expect(coerceToolArguments("not json", schema, "shell")).toBe("not json");
    expect(coerceToolArguments('{"count":120000.0}', undefined, "shell")).toBe('{"count":120000.0}');
  });
});

describe("apply_patch envelope repair", () => {
  test("normalizes decorated delimiters on complete patches", () => {
    const decorated = "*** Begin Patch ***\n*** Update File: x.ts\n+code\n*** End Patch ***";
    expect(isCompletePatchEnvelope(decorated)).toBe(true);
    expect(normalizeApplyPatchDelimiters(decorated)).toBe("*** Begin Patch\n*** Update File: x.ts\n+code\n*** End Patch");
  });

  test("leaves plain patches and non-patch text byte-identical", () => {
    const plain = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
    expect(normalizeApplyPatchDelimiters(plain)).toBe(plain);
    expect(isCompletePatchEnvelope("no patch here")).toBe(false);
  });
});

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

describe("SseParser", () => {
  test("handles CRLF and multi-line data", () => {
    const parser = new SseParser();
    const blocks = parser.push('event: response.created\r\ndata: {"type":"a"}\r\n\r\ndata: {"type":"b"}\n\n');
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0]!.data).type).toBe("a");
  });

  test("flushes a final unterminated block", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"type":"x"}\n\n')).toHaveLength(1);
    expect(parser.push("data: {\"type\":\"y\"}")).toHaveLength(0);
    const tail = parser.finish();
    expect(tail).toHaveLength(1);
    expect(JSON.parse(tail[0]!.data).type).toBe("y");
    expect(parser.finish()).toHaveLength(0);
  });
});
