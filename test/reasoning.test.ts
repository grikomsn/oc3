import { describe, expect, test } from "bun:test";
import { applyReasoningWire, normalizeReasoningForModel } from "../src/desktop-normalize";
import { isReasoningEffort, reasoningWirePayload } from "../src/reasoning";
import { thinkingMetadataFor } from "../src/routing-catalog";
import type { Oc3Model } from "../src/models";

const unknownFamily: Oc3Model = {
  id: "acme/plain-reasoner", rawModelId: "plain-reasoner", providerId: "acme", name: "plain",
  contextLength: 128000, maxOutputTokens: 8192, reasoning: true, imageInput: false,
  toolCalling: true, endpoint: "chat-completions", baseUrl: "https://x.test/v1",
};

const nonReasoning: Oc3Model = { ...unknownFamily, id: "acme/plain", rawModelId: "plain", reasoning: false };

describe("reasoning effort on unknown families", () => {
  test("keeps the effort for reasoning-capable models with no known family", () => {
    const body = { reasoning: { effort: "high" }, input: [] };
    const next = normalizeReasoningForModel(body, unknownFamily, thinkingMetadataFor(unknownFamily));
    expect(next.reasoning).toEqual({ effort: "high" });
    expect(applyReasoningWire(next, unknownFamily).reasoning_effort).toBe("high");
  });

  test("drops reasoning for models that cannot reason", () => {
    const body = { reasoning: { effort: "high" }, input: [] };
    const next = normalizeReasoningForModel(body, nonReasoning, thinkingMetadataFor(nonReasoning));
    expect(next).not.toHaveProperty("reasoning");
  });
});

describe("reasoning effort type", () => {
  test("accepts max as a normalized effort", () => {
    expect(isReasoningEffort("max")).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(reasoningWirePayload("glm", "glm-5.3", "chat-completions", "max")).toEqual({ reasoning_effort: "max" });
  });

  test("deepseek sends no extra wire fields", () => {
    expect(reasoningWirePayload("deepseek", "deepseek-v4", "chat-completions", "high")).toEqual({});
    expect(reasoningWirePayload("deepseek", "deepseek-v4", "chat-completions", "none")).toEqual({});
  });
});
