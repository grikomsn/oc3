// finish_reason → Responses incomplete_details mapping, adapted from
// opencodex src/responses/truncated-stop-reason.ts. Unknown reasons are
// deliberately NOT treated as truncated: an unrecognized value is far more
// likely an ordinary stop, and a healthy turn must never become a failure.

export type TruncationKind = "max_output_tokens" | "content_filter";

const TRUNCATED_STOP_REASONS = new Map<string, TruncationKind>([
  ["max_tokens", "max_output_tokens"],
  ["content_filter", "content_filter"],
  ["length", "max_output_tokens"],
  ["content-filter", "content_filter"],
  ["max_output_tokens", "max_output_tokens"],
  ["model_context_window_exceeded", "max_output_tokens"],
  ["refusal", "content_filter"],
  ["pause_turn", "max_output_tokens"],
  ["malformed_function_call", "content_filter"],
  ["malformed_response", "content_filter"],
  ["unexpected_tool_call", "content_filter"],
  ["safety", "content_filter"],
  ["recitation", "content_filter"],
  ["blocklist", "content_filter"],
  ["prohibited_content", "content_filter"],
  ["spii", "content_filter"],
  ["image_safety", "content_filter"],
  ["language", "content_filter"],
  ["model_context_window_exceeded_exception", "max_output_tokens"],
]);

export function truncatedStopReason(finishReason: string | undefined): TruncationKind | undefined {
  if (!finishReason) return undefined;
  return TRUNCATED_STOP_REASONS.get(finishReason.toLowerCase());
}
