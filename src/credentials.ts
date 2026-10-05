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
// OC3_TEST_TOKEN is the credential-dependent test bypass (temp OC3_HOME only).

import { isGatewayProvider, modelMode, type Oc3Model } from "./models";
import type { OpenCodeMode } from "./protocol";
import type { OpenCodeAuth } from "./auth";
import { loadKeys } from "./store";
import { gatewayKeyFor } from "./gateway";

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
    return session ? await auth.getCredential("console") : undefined;
  }
  const mode = modelMode(model);
  if (model.source !== "console") {
    // A stored service-account key beats the device-flow session for
    // gateway-routed models. The mode's session authorizes gateway requests;
    // with no go sign-in, the console slot's shared session still applies.
    const key = gatewayKeyFor(model.providerId, loadKeys());
    if (key) return { token: key };
    const slot = sessionSlotFor(auth, mode);
    if (slot) return await auth.getCredential(slot);
    return { token: "public" };
  }
  // Org-config models ride the console slot that discovered them.
  if (!auth.isSignedIn("console")) return undefined;
  return await auth.getCredential("console");
}

/** The slot whose session applies for a mode's gateway requests. */
function sessionSlotFor(auth: OpenCodeAuth, mode: OpenCodeMode): OpenCodeMode | undefined {
  if (auth.isSignedIn(mode)) return mode;
  return mode === "go" && auth.isSignedIn("console") ? "console" : undefined;
}

/**
 * The Bearer token used for PUBLIC catalog discovery per mode slot — the same
 * key > slot-session (with go→console compat) precedence as request routing,
 * kept in one place.
 */
export async function discoveryTokens(auth: OpenCodeAuth): Promise<{ consoleToken?: string; goToken?: string }> {
  const keys = loadKeys();
  const consoleSession = auth.isSignedIn("console") ? (await auth.getCredential("console")).token : undefined;
  return {
    consoleToken: gatewayKeyFor("opencode", keys) || consoleSession,
    goToken: gatewayKeyFor("opencode-go", keys) || (auth.getSession("go")?.accessToken ?? consoleSession),
  };
}

export function credentialErrorHint(model: Oc3Model): string {
  if (model.providerId === "openai") return "No credentials for this model provider";
  if (model.source === "gateway" && isGatewayProvider(model.providerId)) {
    return "No OpenCode service key configured. Run `oc3 keys --set <key>` or sign in with `oc3 login` (device code); free models still work anonymously.";
  }
  return "Not signed in. Run: oc3 login";
}