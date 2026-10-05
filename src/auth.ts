import {
  DEFAULT_CONSOLE_SERVER,
  OPENCODE_CLIENT_ID,
  resolveConsoleVerificationUrl,
  type ConsoleOrg,
  type ConsoleSession,
  type DeviceCode,
  type OpenCodeMode,
} from "./protocol";
import { clearModeSession, loadSessions, saveModeSession } from "./store";

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/**
 * OpenCode device-code auth with per-mode slots: a console slot (account/org
 * A drives Console) and a go slot (account/org B drives the subscription).
 * Both slots store Console-shaped sessions; go sign-out never touches console.
 */
export class OpenCodeAuth {
  private refreshPromises = new Map<OpenCodeMode, { identity: string; promise: Promise<ConsoleSession> }>();

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleeper = delay,
  ) {}

  getSession(mode: OpenCodeMode): ConsoleSession | undefined {
    return loadSessions()[mode];
  }

  isSignedIn(mode?: OpenCodeMode): boolean {
    if (mode) return this.getSession(mode) !== undefined;
    return (this.getSession("console") ?? this.getSession("go")) !== undefined;
  }

  async getCredential(mode: OpenCodeMode): Promise<{ token: string; server: string; orgId?: string; orgName?: string }> {
    const session = this.getSession(mode);
    if (!session) throw new Error(`Not signed in to OpenCode ${mode}. Run: oc3 login --mode ${mode}`);
    const fresh = session.expiresAt > this.now() + 5 * 60_000
      ? session
      : await this.refresh(mode, session);
    return { token: fresh.accessToken, server: fresh.server, orgId: fresh.orgId, orgName: fresh.orgName };
  }

  async requestDeviceCode(server = DEFAULT_CONSOLE_SERVER): Promise<DeviceCode> {
    const normalized = server.replace(/\/+$/, "");
    const response = await this.fetcher(`${normalized}/auth/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENCODE_CLIENT_ID }),
    });
    if (!response.ok) throw new Error(`OpenCode Console device authorization failed (${response.status})`);
    const value = await response.json() as Record<string, unknown>;
    const deviceCode = str(value.device_code);
    const userCode = str(value.user_code);
    const verification = str(value.verification_uri_complete);
    if (!deviceCode || !userCode || !verification) throw new Error("OpenCode Console returned an incomplete device-code response");
    return {
      deviceCode,
      userCode,
      verificationUrl: resolveConsoleVerificationUrl(normalized, verification),
      expiresAt: this.now() + positiveNumber(value.expires_in, 600) * 1000,
      intervalMs: Math.max(1000, positiveNumber(value.interval, 5) * 1000),
      server: normalized,
    };
  }

  async completeDeviceSignIn(device: DeviceCode, mode: OpenCodeMode, signal?: AbortSignal, onPoll?: (elapsedSeconds: number) => void): Promise<ConsoleSession> {
    let intervalMs = device.intervalMs;
    const startedAt = this.now();
    while (this.now() < device.expiresAt) {
      await this.sleep(intervalMs, signal);
      onPoll?.(Math.round((this.now() - startedAt) / 1000));
      const response = await this.fetcher(`${device.server}/auth/device/token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.deviceCode,
          client_id: OPENCODE_CLIENT_ID,
        }),
        signal,
      });
      const value = await response.json() as Record<string, unknown>;
      const error = str(value.error);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") { intervalMs += 5000; continue; }
      if (error === "expired_token") throw new Error("OpenCode Console device code expired; start sign-in again");
      if (error === "access_denied") throw new Error("OpenCode Console sign-in was denied");
      const accessToken = str(value.access_token);
      const refreshToken = str(value.refresh_token);
      if (!response.ok || !accessToken || !refreshToken) throw new Error(`OpenCode Console token exchange failed (${response.status})`);
      const [user, orgList] = await Promise.all([
        this.getJson(device.server, "/api/user", accessToken) as Promise<{ id?: unknown; email?: unknown }>,
        this.getJson(device.server, "/api/orgs", accessToken) as Promise<unknown[]>,
      ]);
      const orgs = normalizeOrganizations(orgList);
      const accountId = str(user.id);
      const email = str(user.email);
      if (!accountId || !email) throw new Error("OpenCode Console returned incomplete account information");
      const session: ConsoleSession = {
        mode: "console",
        server: device.server,
        accessToken,
        refreshToken,
        expiresAt: this.now() + positiveNumber(value.expires_in, 3600) * 1000,
        accountId,
        email,
        orgs,
        ...(orgs[0] ? { orgId: orgs[0].id, orgName: orgs[0].name } : {}),
      };
      saveModeSession(mode, session);
      return session;
    }
    throw new Error("OpenCode Console device code expired; start sign-in again");
  }

  private async refresh(mode: OpenCodeMode, session?: ConsoleSession): Promise<ConsoleSession> {
    const current = session ?? this.getSession(mode);
    if (!current) throw new Error(`Not signed in to OpenCode ${mode}. Run: oc3 login --mode ${mode}`);
    const identity = `${current.accessToken}\u0000${current.refreshToken}\u0000${current.expiresAt}`;
    const existing = this.refreshPromises.get(mode);
    if (existing?.identity === identity) return existing.promise;
    const promise = (async (): Promise<ConsoleSession> => {
      const response = await this.fetcher(`${current.server}/auth/device/token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: OPENCODE_CLIENT_ID }),
      });
      if (!response.ok) throw new Error(`OpenCode ${mode} token refresh failed (${response.status})`);
      const value = await response.json() as Record<string, unknown>;
      const accessToken = str(value.access_token);
      if (!accessToken) throw new Error(`OpenCode ${mode} token refresh returned no access token`);
      const next: ConsoleSession = {
        ...current,
        accessToken,
        refreshToken: str(value.refresh_token) ?? current.refreshToken,
        expiresAt: this.now() + positiveNumber(value.expires_in, 3600) * 1000,
      };
      const stored = loadSessions()[mode];
      if (stored && stored.refreshToken === current.refreshToken) saveModeSession(mode, next);
      return next;
    })().finally(() => {
      if (this.refreshPromises.get(mode)?.promise === promise) this.refreshPromises.delete(mode);
    });
    this.refreshPromises.set(mode, { identity, promise });
    return promise;
  }

  async selectOrganization(orgId: string, mode: OpenCodeMode): Promise<ConsoleSession> {
    const session = this.getSession(mode);
    if (!session) throw new Error(`Not signed in to OpenCode ${mode}. Run: oc3 login --mode ${mode}`);
    const match = session.orgs.find((org) => org.id === orgId);
    if (!match) throw new Error(`Organization ${orgId} is not available to this account`);
    const next = { ...session, orgId: match.id, orgName: match.name };
    saveModeSession(mode, next);
    return next;
  }

  async fetchOrganizations(token: string, server: string): Promise<ConsoleOrg[]> {
    const value = await this.getJson(server, "/api/orgs", token) as unknown[];
    return normalizeOrganizations(value);
  }

  /** Clears one mode's slot; the other mode's session is preserved. */
  signOut(mode: OpenCodeMode): void {
    clearModeSession(mode);
  }

  private async getJson(server: string, path: string, token: string): Promise<unknown> {
    const response = await this.fetcher(`${server.replace(/\/+$/, "")}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`OpenCode Console ${path} failed (${response.status})`);
    return response.json();
  }
}

function normalizeOrganizations(value: unknown[]): ConsoleOrg[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const org = item as Record<string, unknown>;
    const id = str(org.id);
    const name = str(org.name);
    return id && name ? [{ id, name }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("OpenCode Console sign-in cancelled"));
    }, { once: true });
  });
}