export const DEFAULT_CONSOLE_SERVER = "https://opencode.ai/console";
export const OPENCODE_CLIENT_ID = "opencode-cli";
export const OPENCODE_CLIENT = "oc3";
// Build-time version define (release workflow --define OC3_VERSION).
declare const OC3_VERSION: string | undefined;

export function userAgent(): string {
  const version = typeof OC3_VERSION !== "undefined" ? OC3_VERSION : "dev";
  return `oc3/${version}`;
}
export const NATIVE_CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";
export const NATIVE_OPENAI_BASE = "https://api.openai.com/v1";

export function nativeChatGptBase(): string {
  return process.env.OC3_CHATGPT_FALLBACK_URL ?? NATIVE_CHATGPT_BASE;
}

export function nativeOpenAiBase(): string {
  return process.env.OC3_OPENAI_FALLBACK_URL ?? NATIVE_OPENAI_BASE;
}

export type EndpointKind = "chat-completions" | "messages" | "responses" | "google";
export type OpenCodeMode = "zen" | "go" | "console";

export interface ConsoleOrg {
  id: string;
  name: string;
}

export interface ConsoleSession {
  mode: "console";
  server: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  email: string;
  orgs: ConsoleOrg[];
  orgId?: string;
  orgName?: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
  server: string;
}

export function resolveConsoleVerificationUrl(server: string, verification: string): string {
  let url: URL;
  try {
    url = new URL(verification, `${server.replace(/\/+$/, "")}/`);
  } catch {
    throw new Error("OpenCode Console returned an invalid verification URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenCode Console returned a non-HTTP verification URL");
  }
  return url.href;
}

export function buildAuthHeaders(endpoint: EndpointKind, token: string): Record<string, string> {
  if (endpoint === "messages") {
    return { "x-api-key": token, "anthropic-version": "2023-06-01" };
  }
  if (endpoint === "google") return { "x-goog-api-key": token };
  return { Authorization: `Bearer ${token}` };
}

export function buildRequestHeaders(
  endpoint: EndpointKind,
  token: string,
  userAgent: string,
  requestId: string,
  sessionId: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...additionalHeaders,
    ...buildAuthHeaders(endpoint, token),
    Accept: "text/event-stream, application/json",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-request": requestId,
    "x-opencode-session": sessionId,
  };
}

export function resolveEndpointKind(modelId: string, mode: OpenCodeMode, packageName?: string): EndpointKind {
  const npm = packageName?.toLowerCase() ?? "";
  if (npm.includes("anthropic")) return "messages";
  if (npm.includes("google")) return "google";
  if (npm === "@ai-sdk/openai" || npm.endsWith("/openai")) return "responses";
  if (/^gpt-/i.test(modelId)) return "responses";
  if (/^claude-/i.test(modelId)) return "messages";
  if (/^grok-(?:4|build)/i.test(modelId)) return "responses";
  if (/^muse-spark-/i.test(modelId)) return "responses";
  if (/^qwen3\.\d+-(?:plus|max|flash)$/i.test(modelId)) return "messages";
  if (mode === "go" && /^minimax-/i.test(modelId)) return "messages";
  if (mode === "zen" && /^gemini-/i.test(modelId)) return "google";
  return "chat-completions";
}

export function endpointUrl(baseUrl: string, endpoint: EndpointKind, modelId: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (endpoint === "messages") return `${base}/messages`;
  if (endpoint === "responses") return `${base}/responses`;
  if (endpoint === "google") return `${base}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  return `${base}/chat/completions`;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
