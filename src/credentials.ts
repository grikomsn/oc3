// Per-model credential resolution. One proxy, several backends:
//   openai         -> OPENAI_API_KEY (native bridge)
//   opencode       -> console service key, else the console slot's session,
//                     else the anonymous "public" sentinel
//   opencode-go    -> go service key, else the go slot's session (compat: the
//                     console slot's when no go sign-in exists, mirroring the
//                     upstream shared-session contract), else anonymous
//   console-org    -> the owning console slot's session token + active org
// Keys take precedence over device sessions for gateway-routed models;
// org-config models prefer the session that discovered them — a key never
// silently overrides a known org. There is never a console→go key fallback.
// Other providers get the Console session only for Console-catalog models on
// the session's own origin.
// OC3_TEST_TOKEN is the credential-dependent test bypass (temp OC3_HOME only).

import { gatewayKeyFor, gatewayProviderId } from "./gateway";
import { isGatewayProvider, modelMode, type Oc3Model } from "./models";
import type { OpenCodeMode } from "./protocol";
import type { OpenCodeAuth } from "./auth";
import { loadKeys } from "./store";

export interface ModelCredential {
  token: string;
  orgId?: string;
  orgName?: string;
}

export async function credentialForModel(model: Oc3Model, auth: OpenCodeAuth): Promise<ModelCredential | undefined> {
  if (model.providerId === "openai") {
    const token = process.env.OPENAI_API_KEY;
    return token ? { token } : undefined;
  }
  const testToken = process.env.OC3_TEST_TOKEN;
  if (testToken) return { token: testToken };
  if (!isGatewayProvider(model.providerId)) {
    const session = auth.getSession("console");
    if (model.source !== "console" || !session || originOf(model.baseUrl) !== originOf(session.server)) return undefined;
    return await auth.getCredential("console");
  }
  if (model.source !== "console") {
    // A stored service-account key beats the device-flow session for
    // gateway-routed models. The mode's session authorizes gateway requests;
    // with no go sign-in, the console slot's shared session still applies.
    return (await resolveSlotToken(auth, modelMode(model))) ?? { token: "public" };
  }
  // Org-config models ride the console slot that discovered them.
  if (!auth.isSignedIn("console")) return undefined;
  return await auth.getCredential("console");
}

/**
 * The credential a mode's gateway traffic uses: its service key, else its
 * session (refreshed when near expiry; go falls back to the console slot's
 * session). Undefined when the mode has no credential at all. Returns the org
 * the session belongs to alongside the token.
 */
export async function resolveSlotToken(auth: OpenCodeAuth, mode: OpenCodeMode): Promise<ModelCredential | undefined> {
  const key = gatewayKeyFor(gatewayProviderId(mode), loadKeys());
  if (key) return { token: key };
  const slot = sessionSlotFor(auth, mode);
  return slot ? await auth.getCredential(slot) : undefined;
}

/** The slot whose session applies for a mode's gateway requests. */
function sessionSlotFor(auth: OpenCodeAuth, mode: OpenCodeMode): OpenCodeMode | undefined {
  if (auth.isSignedIn(mode)) return mode;
  return mode === "go" && auth.isSignedIn("console") ? "console" : undefined;
}

export interface DiscoveryTokens {
  consoleToken?: string;
  goToken?: string;
  errors: string[];
}

/**
 * The Bearer tokens for PUBLIC catalog discovery, one per mode slot, resolved
 * by resolveSlotToken. The slots settle independently: a refresh failure is
 * reported in `errors` and that slot discovers anonymously. Both start together
 * so a shared console session refreshes once for both slots.
 */
export async function discoveryTokens(auth: OpenCodeAuth): Promise<DiscoveryTokens> {
  const [consoleSlot, goSlot] = await Promise.allSettled([
    resolveSlotToken(auth, "console"),
    resolveSlotToken(auth, "go"),
  ]);
  const errors = new Set<string>();
  for (const slot of [consoleSlot, goSlot]) {
    if (slot.status === "rejected") errors.add(slot.reason instanceof Error ? slot.reason.message : String(slot.reason));
  }
  return {
    consoleToken: consoleSlot.status === "fulfilled" ? consoleSlot.value?.token : undefined,
    goToken: goSlot.status === "fulfilled" ? goSlot.value?.token : undefined,
    errors: [...errors],
  };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function credentialErrorHint(model: Oc3Model): string {
  if (model.providerId === "openai") return "No credentials for this model provider";
  if (model.source === "gateway" && isGatewayProvider(model.providerId)) {
    return "No OpenCode service key configured. Run `oc3 keys --set <key>` or sign in with `oc3 login` (device code); free models still work anonymously.";
  }
  return "Not signed in. Run: oc3 login";
}
