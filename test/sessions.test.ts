import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { OpenCodeAuth } from "../src/auth";
import { clearSession, ensureHome, keysPath, loadKeys, loadSession, loadSessions, saveKeys, saveModeSession, sessionPath, sessionsPath } from "../src/store";
import { portOf, readJson, sessionFixture, tempRoot, writeLegacySession, writeSlots } from "./helpers";
import type { ConsoleSession, DeviceCode } from "../src/protocol";

const HOME = tempRoot("oc3-sessions-test");

const accountByDevice: Record<string, { access: string; refresh: string; accountId: string; email: string; org: { id: string; name: string } }> = {
  "dev-console": { access: "console-acc", refresh: "cons-ref", accountId: "acct-a", email: "a@example.com", org: { id: "org-a", name: "Org A" } },
  "dev-go": { access: "go-acc", refresh: "go-ref", accountId: "acct-b", email: "b@example.com", org: { id: "org-b", name: "Org B" } },
};
const refreshByToken: Record<string, { access: string; refresh: string }> = {
  "cons-ref": { access: "console-acc-2", refresh: "cons-ref-2" },
  "go-ref": { access: "go-acc-2", refresh: "go-ref-2" },
};

const authUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/auth/device/token") {
      const body = await request.json() as Record<string, unknown>;
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const account = accountByDevice[String(body.device_code)];
        if (!account) return Response.json({ error: "authorization_pending" });
        return Response.json({ access_token: account.access, refresh_token: account.refresh, expires_in: 3600 });
      }
      if (body.grant_type === "refresh_token") {
        const rotated = refreshByToken[String(body.refresh_token)];
        if (!rotated) return new Response("unknown refresh token", { status: 401 });
        return Response.json({ access_token: rotated.access, refresh_token: rotated.refresh, expires_in: 3600 });
      }
    }
    if (url.pathname === "/api/user") {
      const token = request.headers.get("authorization") ?? "";
      for (const device of Object.values(accountByDevice)) {
        if (token === `Bearer ${device.access}`) return Response.json({ id: device.accountId, email: device.email });
      }
      return new Response("unknown token", { status: 401 });
    }
    if (url.pathname === "/api/orgs") {
      const token = request.headers.get("authorization") ?? "";
      for (const device of Object.values(accountByDevice)) {
        if (token === `Bearer ${device.access}`) return Response.json([device.org]);
      }
      return new Response("unknown token", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  },
});

const MOCK_SERVER = `http://127.0.0.1:${portOf(authUpstream)}`;

function device(deviceCode: string): DeviceCode {
  return {
    deviceCode,
    userCode: "CODE",
    verificationUrl: `${MOCK_SERVER}/device`,
    expiresAt: Date.now() + 60_000,
    intervalMs: 5,
    server: MOCK_SERVER,
  };
}

function slotSession(token: string, overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return sessionFixture({ token, server: MOCK_SERVER, ...overrides });
}

function setHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(`${HOME}/oc3`, { recursive: true });
  process.env.OC3_HOME = `${HOME}/oc3`;
}

const savedEnv = process.env.OC3_HOME;

beforeAll(setHome);
afterAll(() => {
  authUpstream.stop(true);
  rmSync(HOME, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.OC3_HOME;
  else process.env.OC3_HOME = savedEnv;
});

describe("per-mode session slots", () => {
  test("legacy session.json migrates into the console slot and is cleared", () => {
    setHome();
    const legacy = sessionFixture({ token: "legacy-token", server: MOCK_SERVER, refreshToken: "refresh" });
    writeLegacySession(process.env.OC3_HOME!, "legacy-token", MOCK_SERVER, legacy);
    const sessions = loadSessions();
    expect(sessions.console).toEqual(legacy);
    expect(sessions.go).toBeUndefined();
    expect(readJson<Record<string, unknown>>(sessionPath())).toEqual({});
    expect(readJson<Record<string, unknown>>(sessionsPath())).toEqual({ console: legacy });
    // idempotent once migrated
    expect(loadSessions()).toEqual({ console: legacy });
  });

  test("mode slots persist independently", () => {
    setHome();
    const consoleSession = slotSession("console-token");
    const goSession = sessionFixture({ token: "go-token", server: MOCK_SERVER, refreshToken: "go-ref", accountId: "acct-b", email: "b@example.com", orgId: "org-b", orgName: "Org B" });
    saveModeSession("console", consoleSession);
    saveModeSession("go", goSession);
    expect(loadSessions()).toEqual({ console: consoleSession, go: goSession });
    // invalid slot entries are dropped on load
    writeSlots(process.env.OC3_HOME!, { console: { garbage: true } as unknown as ConsoleSession, go: goSession });
    expect(loadSessions()).toEqual({ go: goSession });
  });

  test("sign-out clears one slot and preserves the other", () => {
    setHome();
    const auth = new OpenCodeAuth();
    saveModeSession("console", slotSession("console-token"));
    saveModeSession("go", slotSession("go-token", { refreshToken: "go-ref" }));
    auth.signOut("go");
    expect(auth.isSignedIn("go")).toBe(false);
    expect(auth.isSignedIn("console")).toBe(true);
    expect(auth.isSignedIn()).toBe(true);
    auth.signOut("console");
    expect(auth.isSignedIn()).toBe(false);
  });

  test("legacy load/clear helpers stay available for migration", () => {
    setHome();
    writeLegacySession(process.env.OC3_HOME!, "legacy-token", MOCK_SERVER);
    expect(loadSession()?.accessToken).toBe("legacy-token");
    clearSession();
    expect(loadSession()).toBeUndefined();
    expect(existsSync(sessionPath())).toBe(true);
  });
});

describe("mode-scoped device sign-in", () => {
  test("each slot signs in its own account without touching the other", async () => {
    setHome();
    const auth = new OpenCodeAuth();
    const consoleSession = await auth.completeDeviceSignIn(device("dev-console"), "console");
    expect(consoleSession.accountId).toBe("acct-a");
    expect(consoleSession.orgId).toBe("org-a");
    expect(auth.isSignedIn("go")).toBe(false);
    const goSession = await auth.completeDeviceSignIn(device("dev-go"), "go");
    expect(goSession.accountId).toBe("acct-b");
    expect(goSession.orgId).toBe("org-b");
    const sessions = loadSessions();
    expect(sessions.console?.accountId).toBe("acct-a");
    expect(sessions.go?.accountId).toBe("acct-b");
  });

  test("credential resolution and refresh are per-slot", async () => {
    setHome();
    const auth = new OpenCodeAuth();
    await auth.completeDeviceSignIn(device("dev-console"), "console");
    await auth.completeDeviceSignIn(device("dev-go"), "go");
    const consoleCred = await auth.getCredential("console");
    expect(consoleCred.token).toBe("console-acc");
    expect(consoleCred.orgId).toBe("org-a");
    const goCred = await auth.getCredential("go");
    expect(goCred.token).toBe("go-acc");
    expect(goCred.orgId).toBe("org-b");
    // expired console slot refreshes against its own account only
    const expired = loadSessions().console!;
    saveModeSession("console", { ...expired, expiresAt: Date.now() - 1000 });
    await expect(auth.getCredential("console")).resolves.toMatchObject({ token: "console-acc-2" });
    expect(loadSessions().go?.accessToken).toBe("go-acc");
    expect(loadSessions().console?.refreshToken).toBe("cons-ref-2");
  });

  test("org selection is scoped to one slot", async () => {
    setHome();
    const auth = new OpenCodeAuth();
    saveModeSession("console", {
      ...slotSession("console-token"),
      orgs: [{ id: "org-a1", name: "Org A1" }, { id: "org-a2", name: "Org A2" }],
      orgId: "org-a1",
      orgName: "Org A1",
    });
    saveModeSession("go", slotSession("go-token", { refreshToken: "go-ref", orgId: "org-b", orgName: "Org B" }));
    const next = await auth.selectOrganization("org-a2", "console");
    expect(next.orgId).toBe("org-a2");
    expect(loadSessions().go?.orgId).toBe("org-b");
  });
});

describe("state file modes and atomic writes", () => {
  test("ensureHome creates the state directory as 0700", () => {
    const fresh = `${HOME}/fresh-state`;
    rmSync(fresh, { recursive: true, force: true });
    process.env.OC3_HOME = fresh;
    ensureHome();
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });

  test("saved session and key files are 0600 with no temp files left behind", () => {
    setHome();
    saveModeSession("console", slotSession("console-token"));
    saveKeys({ console: "console-key" });
    expect(statSync(sessionsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(keysPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(process.env.OC3_HOME!).sort()).toEqual(["keys.json", "sessions.json"]);
  });

  test("saves replace the file rather than writing it in place", () => {
    setHome();
    saveModeSession("console", slotSession("console-token"));
    const before = statSync(sessionsPath()).ino;
    saveModeSession("go", slotSession("go-token", { refreshToken: "go-ref" }));
    expect(statSync(sessionsPath()).ino).not.toBe(before);
  });
});

describe("corrupt state files", () => {
  test("a corrupt sessions.json is moved aside and the next save does not overwrite it", () => {
    setHome();
    const home = process.env.OC3_HOME!;
    const corrupt = `{"console": ${JSON.stringify(slotSession("console-token"))}`;
    writeFileSync(sessionsPath(), corrupt, { mode: 0o600 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadSessions()).toEqual({});
      saveModeSession("go", slotSession("go-token", { refreshToken: "go-ref" }));
      expect(Object.keys(loadSessions())).toEqual(["go"]);
      const aside = readdirSync(home).filter((name) => name.startsWith("sessions.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(`${home}/${aside[0]}`, "utf8")).toBe(corrupt);
      expect(statSync(`${home}/${aside[0]}`).mode & 0o777).toBe(0o600);
      expect(errors).toHaveBeenCalledTimes(1);
      const warning = String(errors.mock.calls[0]?.[0]);
      expect(warning).toContain("sessions.json");
      expect(warning).not.toContain("console-token");
    } finally {
      errors.mockRestore();
    }
  });

  test("a corrupt keys.json is moved aside and the next save does not overwrite it", () => {
    setHome();
    const home = process.env.OC3_HOME!;
    const corrupt = `{"console": "console-key", "go": "go-key"`;
    writeFileSync(keysPath(), corrupt, { mode: 0o600 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadKeys()).toEqual({});
      saveKeys({ ...loadKeys(), go: "new-go-key" });
      expect(loadKeys()).toEqual({ go: "new-go-key" });
      const aside = readdirSync(home).filter((name) => name.startsWith("keys.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(`${home}/${aside[0]}`, "utf8")).toBe(corrupt);
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("console-key");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("session shape validation", () => {
  test("sessions with malformed orgs or expiresAt are dropped without touching the other slot", () => {
    setHome();
    const home = process.env.OC3_HOME!;
    const valid = slotSession("go-token", { refreshToken: "go-ref" });
    const broken = [
      { ...slotSession("console-token"), orgs: "org-a" },
      { ...slotSession("console-token"), orgs: [null] },
      { ...slotSession("console-token"), expiresAt: "tomorrow" },
    ];
    for (const session of broken) {
      writeSlots(home, { console: session as unknown as ConsoleSession, go: valid });
      expect(loadSessions()).toEqual({ go: valid });
    }
  });

  test("sessions must target https, except loopback http for dev overrides", () => {
    setHome();
    const home = process.env.OC3_HOME!;
    const session = slotSession("console-token");
    writeSlots(home, { console: { ...session, server: "http://example.com/console" } });
    expect(loadSessions()).toEqual({});
    writeSlots(home, { console: { ...session, server: "http://localhost:8911" } });
    expect(loadSessions().console?.server).toBe("http://localhost:8911");
    writeSlots(home, { console: { ...session, server: "https://opencode.ai/console" } });
    expect(loadSessions().console?.server).toBe("https://opencode.ai/console");
  });

  test("device sign-in refuses a non-https Console server before any request", async () => {
    setHome();
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      requested.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const auth = new OpenCodeAuth(fetcher);
    await expect(auth.requestDeviceCode("http://example.com/console")).rejects.toThrow("https");
    expect(requested).toEqual([]);
  });

  test("organization selection on a malformed session reports not signed in instead of throwing a TypeError", async () => {
    setHome();
    writeSlots(process.env.OC3_HOME!, { console: { ...slotSession("console-token"), orgs: "org-a" } as unknown as ConsoleSession });
    const auth = new OpenCodeAuth();
    await expect(auth.selectOrganization("org-a", "console")).rejects.toThrow("Not signed in to OpenCode console");
  });
});

describe("refresh failures", () => {
  test("an expired session whose refresh token is rejected surfaces an error", async () => {
    setHome();
    saveModeSession("console", { ...slotSession("expired-token", { refreshToken: "cons-ref-revoked" }), expiresAt: Date.now() - 1000 });
    const auth = new OpenCodeAuth();
    await expect(auth.getCredential("console")).rejects.toThrow("OpenCode console token refresh failed (401)");
  });

  test("a rejected refresh returns the session another process rotated in the meantime", async () => {
    setHome();
    const stale = { ...slotSession("stale-token", { refreshToken: "cons-ref-stale" }), expiresAt: Date.now() - 1000 };
    saveModeSession("console", stale);
    const rotated = { ...stale, accessToken: "rotated-token", refreshToken: "cons-ref-rotated", expiresAt: Date.now() + 3600_000 };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (body.refresh_token === "cons-ref-stale") saveModeSession("console", rotated);
      return fetch(input, init);
    }) as typeof fetch;
    const auth = new OpenCodeAuth(fetcher);
    await expect(auth.getCredential("console")).resolves.toMatchObject({ token: "rotated-token" });
    expect(loadSessions().console?.refreshToken).toBe("cons-ref-rotated");
  });
});