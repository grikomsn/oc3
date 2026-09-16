// Per-model credential resolution. One proxy, several backends:
//   openai         -> OPENAI_API_KEY (native bridge)
//   opencode(-go)  -> Zen gateway key (keys.json / OPENCODE_API_KEY, "public" sentinel)
//   console        -> device-code session token + active org
// OC3_TEST_TOKEN is the credential-dependent test bypass (temp OC3_HOME only).

import type { Oc3Model } from "./models";
import type { OpenCodeAuth } from "./auth";
import { loadKeys } from "./store";
import { gatewayKeyFor } from "./zen";

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
  if (model.providerId === "opencode" || model.providerId === "opencode-go") {
    // The gateway's own catalogs use its API key; the same provider ids can
    // also appear in the Console org config, where the session token applies.
    if ((model.source ?? "console") === "gateway") {
      const keys = loadKeys();
      return { token: gatewayKeyFor(model.providerId, keys) || "public" };
    }
  }
  if (!auth.isSignedIn()) return undefined;
  return await auth.getCredential();
}

export function credentialErrorHint(model: Oc3Model): string {
  if (model.providerId === "openai") return "No credentials for this model provider";
  if (model.source === "gateway"
    && (model.providerId === "opencode" || model.providerId === "opencode-go")) {
    return "No OpenCode API key configured. Run `oc3 keys --set <key>` (or set OPENCODE_API_KEY); free models still work anonymously.";
  }
  return "Not signed in. Run: oc3 login";
}
