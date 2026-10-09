import { describe, expect, test } from "bun:test";
import { coerceToolArguments, isCompletePatchEnvelope, normalizeApplyPatchDelimiters } from "../src/tool-args-repair";

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

  test("splices only repaired literals so large integers survive exactly", () => {
    const wide = { type: "object", properties: { id: { type: "string" }, count: { type: "integer" } } };
    expect(coerceToolArguments('{"id":12345678901234567890,"count":5.0}', wide, "shell"))
      .toBe('{"id":12345678901234567890,"count":5}');
    expect(coerceToolArguments('{ "count" : 5.0 , "id": 12345678901234567890 }', wide, "shell"))
      .toBe('{ "count" : 5 , "id": 12345678901234567890 }');
  });

  test("ignores number-like text inside strings and repairs the last duplicate key", () => {
    expect(coerceToolArguments('{"note":"see \\"5.0\\"","count":5.0}', schema, "shell"))
      .toBe('{"note":"see \\"5.0\\"","count":5}');
    expect(coerceToolArguments('{"count":1.0,"count":2.0}', schema, "shell")).toBe('{"count":1.0,"count":2}');
  });

  test("reads object properties through anyOf, allOf, and additionalProperties", () => {
    const anyOfRoot = { anyOf: [{ type: "object", properties: { count: { type: "integer" } } }, { type: "null" }] };
    expect(coerceToolArguments('{"count":5.0}', anyOfRoot, "shell")).toBe('{"count":5}');
    const nested = { type: "object", properties: { opts: anyOfRoot } };
    expect(coerceToolArguments('{"opts":{"count":5.0}}', nested, "shell")).toBe('{"opts":{"count":5}}');
    const allOf = { allOf: [{ type: "object", properties: { a: { type: "integer" } } }, { type: "object", properties: { b: { type: "integer" } } }] };
    expect(coerceToolArguments('{"a":1.0,"b":2.0}', allOf, "shell")).toBe('{"a":1,"b":2}');
    const extra = { anyOf: [{ type: "object", additionalProperties: { type: "integer" } }] };
    expect(coerceToolArguments('{"anything":2.0}', extra, "shell")).toBe('{"anything":2}');
  });

  test("resolves $ref targets inside composition branches and array items", () => {
    const refBranch = {
      anyOf: [{ $ref: "#/$defs/inner" }, { type: "null" }],
      $defs: { inner: { type: "object", properties: { depth: { type: "integer" } } } },
    };
    expect(coerceToolArguments('{"depth":3.0}', refBranch, "shell")).toBe('{"depth":3}');
    const ids = { type: "object", properties: { ids: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }] } } };
    expect(coerceToolArguments('{"ids":[1.0,2.0]}', ids, "shell")).toBe('{"ids":[1,2]}');
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
