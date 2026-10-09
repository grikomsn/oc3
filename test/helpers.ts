// Shared test fixtures/env helpers for gateway, sessions, and server tests.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleSession } from "../src/protocol";

/** A fresh directory under the system temp dir, so runs never share state. */
export function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** The port a server bound. Servers started with port 0 report it only after binding. */
export function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("server did not bind a port");
  return server.port;
}

/**
 * A loopback port nothing is listening on right now. Use it only where a flag or
 * config must name the port before the server starts; otherwise bind port 0 and
 * read the port back with portOf().
 */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = portOf(probe);
  probe.stop(true);
  return port;
}

/** Save-and-restore an env var for the current test file. */
export function envSaver(): {
  set: (key: string, value: string | undefined) => void;
  restore: () => void;
} {
  const saved = new Map<string, string | undefined>();
  return {
    set(key, value) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
    },
  };
}

export interface SlotFixture {
  token: string;
  refreshToken?: string;
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  server?: string;
}

/** A Console-shaped session fixture for one mode slot. */
export function sessionFixture(overrides: SlotFixture): ConsoleSession {
  const token = overrides.token;
  const accountId = overrides.accountId ?? "acct-a";
  const email = overrides.email ?? "a@example.com";
  const orgId = overrides.orgId ?? "org-a";
  const orgName = overrides.orgName ?? "Org A";
  return {
    mode: "console",
    server: overrides.server ?? "https://opencode.ai/console",
    accessToken: token,
    refreshToken: overrides.refreshToken ?? `${token}-refresh`,
    expiresAt: Date.now() + 3600_000,
    accountId,
    email,
    orgs: [{ id: orgId, name: orgName }],
    orgId,
    orgName,
  };
}

/** Legacy single-session file write (exercises the load-time migration). */
export function writeLegacySession(
  home: string,
  token: string,
  server = "https://opencode.ai/console",
  fixture?: ConsoleSession,
): void {
  writeFileSync(`${home}/session.json`, JSON.stringify(fixture ?? sessionFixture({
    token,
    server,
    refreshToken: "refresh",
    accountId: "acct-1",
    email: "test@example.com",
    orgId: "org-1",
    orgName: "Org",
  })), { mode: 0o600 });
}

/** Per-mode slots file write. */
export function writeSlots(home: string, sessions: { console?: ConsoleSession; go?: ConsoleSession }): void {
  writeFileSync(`${home}/sessions.json`, JSON.stringify(sessions), { mode: 0o600 });
}

/** Read raw JSON for assertions. */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}