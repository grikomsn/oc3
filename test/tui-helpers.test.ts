import { describe, expect, test } from "bun:test";
import { filterModels, formatRequestRecord, modelDescription, usageLines } from "../src/tui";
import { sortModelsByGroup, type Oc3Model } from "../src/models";

function model(overrides: Partial<Oc3Model> & { id: string; name: string; providerId: string }): Oc3Model {
  return {
    rawModelId: overrides.id,
    contextLength: 128_000,
    maxOutputTokens: 8192,
    reasoning: false,
    imageInput: false,
    toolCalling: true,
    endpoint: "responses",
    baseUrl: "https://example.test",
    ...overrides,
  } as Oc3Model;
}

describe("sortModels", () => {
  test("groups by backend family then sorts by name", () => {
    const sorted = sortModelsByGroup([
      model({ id: "opencode-go/zeta", name: "Zeta", providerId: "opencode-go", source: "gateway" }),
      model({ id: "opencode/alpha", name: "Alpha", providerId: "opencode", source: "gateway" }),
      model({ id: "console/mid", name: "Mid", providerId: "console-org", source: "console" }),
    ]);
    expect(sorted.map((model) => model.id)).toEqual(["console/mid", "opencode/alpha", "opencode-go/zeta"]);
  });
});

describe("filterModels", () => {
  test("matches id, name, endpoint case-insensitively", () => {
    const models = [
      model({ id: "opencode/gpt-5", name: "GPT-5", providerId: "opencode", source: "gateway" }),
      model({ id: "console/claude", name: "Claude", providerId: "console-org", source: "console", endpoint: "messages" }),
    ];
    expect(filterModels(models, "GPT").map((model) => model.id)).toEqual(["opencode/gpt-5"]);
    expect(filterModels(models, "messages").map((model) => model.id)).toEqual(["console/claude"]);
    expect(filterModels(models, "  ")).toHaveLength(2);
  });
});

describe("modelDescription", () => {
  test("includes endpoint, context, cost, and efforts", () => {
    const base = model({ id: "x", name: "X", providerId: "opencode", source: "gateway" });
    expect(modelDescription(base)).toBe("responses · ctx 128000");
    expect(modelDescription({ ...base, cost: { input: 1.5, output: 10 } })).toContain("$1.5/10");
    expect(modelDescription({ ...base, reasoningEfforts: ["low", "high"] })).toContain("low/high");
  });
});

describe("formatRequestRecord", () => {
  test("formats time, status, duration, model", () => {
    const line = formatRequestRecord({ at: Date.UTC(2026, 8, 16, 12, 0, 0), model: "opencode/gpt-5", status: 200, ms: 42 });
    expect(line).toContain("200");
    expect(line).toContain("42ms");
    expect(line).toContain("opencode/gpt-5");
  });
});

describe("usageLines", () => {
  test("flattens nested objects and scalar values", () => {
    const lines = usageLines({ requests: 12, detail: { input_tokens: 100.5, output_tokens: 200 } });
    expect(lines).toEqual(["requests: 12", "detail:", "  input_tokens: 100.5", "  output_tokens: 200"]);
    expect(usageLines({})).toEqual(["(no usage data returned)"]);
  });
});
