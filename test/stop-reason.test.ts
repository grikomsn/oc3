import { describe, expect, test } from "bun:test";
import { truncatedStopReason } from "../src/stop-reason";

describe("truncatedStopReason", () => {
  test("maps truncation reasons to incomplete kinds", () => {
    expect(truncatedStopReason("length")).toBe("max_output_tokens");
    expect(truncatedStopReason("max_tokens")).toBe("max_output_tokens");
    expect(truncatedStopReason("content_filter")).toBe("content_filter");
    expect(truncatedStopReason("LENGTH")).toBe("max_output_tokens");
  });

  test("does not treat unknown or ordinary stop reasons as truncated", () => {
    for (const reason of ["stop", "tool_calls", "end_turn", "function_call", "completed", "some_new_reason", ""]) {
      expect(truncatedStopReason(reason)).toBeUndefined();
    }
    expect(truncatedStopReason(undefined)).toBeUndefined();
  });
});
