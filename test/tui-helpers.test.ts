import { describe, expect, test } from "bun:test";
import { filterModels, formatContextLength, formatRequestRecord, fuzzyScore, maskKey, modelDescription, usageLines } from "../src/tui";
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
  test("fuzzy-matches id, name, tag, and endpoint", () => {
    const models = [
      model({ id: "opencode/gpt-5", name: "GPT-5", providerId: "opencode", source: "gateway" }),
      model({ id: "console/claude", name: "Claude", providerId: "console-org", source: "console", endpoint: "messages" }),
    ];
    expect(filterModels(models, "GPT").map((model) => model.id)).toEqual(["opencode/gpt-5"]);
    expect(filterModels(models, "messages").map((model) => model.id)).toEqual(["console/claude"]);
    expect(filterModels(models, "  ")).toHaveLength(2);
    // subsequence: gpt5 matches GPT-5 even without the dash
    expect(filterModels(models, "gpt5")).toHaveLength(1);
  });

  test("ranks prefix matches above scattered ones", () => {
    const models = [
      model({ id: "opencode/claude-haiku", name: "Claude Haiku", providerId: "opencode", source: "gateway" }),
      model({ id: "opencode/claude", name: "Claude", providerId: "opencode", source: "gateway" }),
    ];
    const ranked = filterModels(models, "claude");
    expect(ranked[0]!.id).toBe("opencode/claude");
  });
});

describe("fuzzyScore", () => {
  test("returns undefined when the needle is not a subsequence", () => {
    expect(fuzzyScore("gpt-5", "xyz")).toBeUndefined();
    expect(fuzzyScore("claude", "gpt")).toBeUndefined();
  });

  test("ranks exact > prefix > word-start > scattered", () => {
    const exact = fuzzyScore("gpt-5", "gpt-5")!;
    const prefix = fuzzyScore("gpt-5-turbo", "gpt-5")!;
    const wordStart = fuzzyScore("openai gpt-5", "gpt-5")!;
    const scattered = fuzzyScore("g-x-p-t-5", "gpt5")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(scattered);
  });

  test("empty needle matches everything with score 0", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });
});

describe("maskKey", () => {
  test("masks keys and reports unset", () => {
    expect(maskKey("sk-abcdef1234567890")).toBe("sk-a…7890");
    expect(maskKey("short")).toBe("••••••");
    expect(maskKey(undefined)).toBe("not set");
  });
});

describe("formatContextLength", () => {
  test("compacts to k/M", () => {
    expect(formatContextLength(400_000)).toBe("400k");
    expect(formatContextLength(1_200_000)).toBe("1.2M");
    expect(formatContextLength(512)).toBe("512");
  });
});

describe("modelDescription", () => {
  test("includes endpoint, context, cost, and efforts", () => {
    const base = model({ id: "x", name: "X", providerId: "opencode", source: "gateway" });
    expect(modelDescription(base)).toBe("responses · ctx 128k");
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
