// Shared test fixtures/env helpers for gateway, sessions, and server tests.

import { readFileSync, writeFileSync } from "node:fs";
import type { ConsoleSession } from "../src/protocol";

/** Save-and-restore an env var for the current test file. */
export function envSaver(): {
  set: (key: string, value: string | undefined) => void;
  restore: () => void;
} {
  const saved: Record<string, string | undefined> = {};
  return {
    set(key, value) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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