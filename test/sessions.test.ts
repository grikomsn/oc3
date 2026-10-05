import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { OpenCodeAuth } from "../src/auth";
import { clearSession, loadSession, loadSessions, saveModeSession, sessionPath, sessionsPath } from "../src/store";
import { readJson, sessionFixture, writeLegacySession, writeSlots } from "./helpers";
import type { ConsoleSession, DeviceCode } from "../src/protocol";

const HOME = "/tmp/oc3-sessions-test";
const AUTH_PORT = 8911;

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
  port: AUTH_PORT,
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

const MOCK_SERVER = `http://127.0.0.1:${AUTH_PORT}`;

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