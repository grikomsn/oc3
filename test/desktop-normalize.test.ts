import { describe, expect, test } from "bun:test";
import { normalizeFullAccessExecTool, normalizeInputItems, normalizeReasoningForModel, resolveAutoReview, sanitizeCrossProviderHistory, TurnModelCache } from "../src/desktop-normalize";
import { normalizeReasoningEffort, thinkingMetadataFor } from "../src/routing-catalog";
import type { Oc3Model } from "../src/models";

const glm: Oc3Model = {
  id: "acme/glm-5.3", rawModelId: "glm-5.3", providerId: "acme", name: "glm",
  contextLength: 128000, maxOutputTokens: 8192, reasoning: true, imageInput: false,
  toolCalling: true, endpoint: "chat-completions", baseUrl: "https://x.test/v1",
};

describe("normalizeFullAccessExecTool", () => {
  const body = {
    sandbox_mode: "danger-full-access",
    tools: [{
      type: "function",
      name: "exec_command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, require_escalated: { type: "boolean" } },
        required: ["cmd", "require_escalated"],
      },
    }],
  };
  test("strips require_escalated under full access", () => {
    const { body: next, changed } = normalizeFullAccessExecTool(body, "danger-full-access");
    expect(changed).toBe(true);
    const tool = (next.tools as Array<Record<string, unknown>>)[0]!;
    const params = tool.parameters as Record<string, unknown>;
    expect(params.properties).toEqual({ cmd: { type: "string" } });
    expect(params.required).toEqual(["cmd"]);
  });
  test("leaves tools alone in sandboxed modes", () => {
    const { changed } = normalizeFullAccessExecTool(body, "workspace-write");
    expect(changed).toBe(false);
  });
});

describe("auto-review alias", () => {
  test("tracks turn models and resolves the alias to the parent turn's model", () => {
    const cache = new TurnModelCache(4);
    resolveAutoReview("acme/gpt-5.6-sol", { client_metadata: { turn_id: "t1" } }, cache, "acme/gpt-5.6-sol", "openai");
    const resolved = resolveAutoReview("codex-auto-review", { client_metadata: { parent_turn_id: "t1" } }, cache, "acme/gpt-5.6-sol", "openai");
    expect(resolved).toBeDefined();
    expect(resolved!.model).toBe("acme/gpt-5.6-sol");
    expect(resolved!.body.model).toBe("acme/gpt-5.6-sol");
    expect(resolved!.rewritten).toBe(true);
  });
});

describe("normalizeInputItems", () => {
  test("converts custom_tool_call items to function_call items", () => {
    const { body, changed } = normalizeInputItems({
      input: [
        { type: "custom_tool_call", id: "i1", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "c1", output: "done" },
      ],
    });
    expect(changed).toBe(true);
    expect((body.input as unknown[])[0]).toEqual({
      type: "function_call", id: "i1", call_id: "c1", name: "apply_patch",
      input: "*** Begin Patch", arguments: "*** Begin Patch",
    });
    expect((body.input as unknown[])[1]).toEqual({ type: "function_call_output", call_id: "c1", output: "done" });
  });
});

describe("reasoning normalization", () => {
  test("clamps xhigh to max for glm", () => {
    const thinking = thinkingMetadataFor(glm)!;
    expect(thinking.levels).toEqual(["low", "high", "max"]);
    expect(normalizeReasoningEffort("xhigh", thinking)).toBe("max");
  });

  test("drops reasoning for non-reasoning models", () => {
    const plain: Oc3Model = { ...glm, rawModelId: "fast", reasoning: false };
    const next = normalizeReasoningForModel({ reasoning: { effort: "high" } }, plain, thinkingMetadataFor(plain));
    expect("reasoning" in next).toBe(false);
  });

  test("binary thinking maps to medium", () => {
    expect(normalizeReasoningEffort("high", { supported: true, levels: ["none", "medium"] })).toBe("medium");
    expect(normalizeReasoningEffort("none", { supported: true, levels: ["none", "medium"] })).toBe("none");
  });
});

describe("routing catalog thinking metadata", () => {
  test("returns per-family levels for reasoning models", () => {
    expect(thinkingMetadataFor(glm)!.levels).toEqual(["low", "high", "max"]);
    expect(thinkingMetadataFor({ ...glm, rawModelId: "fast", reasoning: false })).toBeUndefined();
  });
});

describe("cross-provider history sanitation", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1234", encrypted_content: "AAAA", summary: [] },
      { type: "reasoning", id: "reasoning_plain", summary: [{ type: "summary_text", text: "thinking" }] },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
    ],
  };

  test("drops backend-encrypted reasoning items on backend-family switches", () => {
    const { body: next, changed } = sanitizeCrossProviderHistory(body, "zen", "console");
    expect(changed).toBe(true);
    const input = next.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input.find((item) => item.type === "reasoning" && item.id === "reasoning_plain")).toBeDefined();
  });

  test("keeps history when the backend family is unchanged or unknown", () => {
    expect(sanitizeCrossProviderHistory(body, "zen", "zen").changed).toBe(false);
    expect(sanitizeCrossProviderHistory(body, undefined, "zen").changed).toBe(false);
  });

  test("keeps plain reasoning summaries across families", () => {
    const plainOnly = { input: [{ type: "reasoning", id: "reasoning_plain", summary: [] }] };
    const { body: next, changed } = sanitizeCrossProviderHistory(plainOnly, "zen", "console");
    expect(changed).toBe(false);
    expect(next.input).toHaveLength(1);
  });
});

describe("turn model cache groups", () => {
  test("remembers and reports the backend family per turn", () => {
    const cache = new TurnModelCache(4);
    cache.remember("t1", "zen/gpt", "zen");
    cache.remember("t2", "console/claude", "console");
    expect(cache.lookup("t1")?.group).toBe("zen");
    expect(cache.lookup("t2")?.group).toBe("console");
    expect(cache.lookup("missing")).toBeUndefined();
  });
});
