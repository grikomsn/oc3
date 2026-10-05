import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleSession, OpenCodeMode } from "./protocol";

export function oc3Home(): string {
  return process.env.OC3_HOME ?? `${process.env.HOME}/.config/oc3`;
}

export function sessionPath(): string {
  return join(oc3Home(), "session.json");
}

export function modelsPath(): string {
  return join(oc3Home(), "models.json");
}

export function codexCatalogPath(): string {
  return join(oc3Home(), "codex-models.json");
}

export function statePath(): string {
  return join(oc3Home(), "state.json");
}

export function ensureHome(): void {
  mkdirSync(oc3Home(), { recursive: true });
}

export function loadSession(): ConsoleSession | undefined {
  const path = sessionPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ConsoleSession>;
    if (value.mode !== "console" || !value.accessToken || !value.refreshToken || !value.server) return undefined;
    return value as ConsoleSession;
  } catch {
    return undefined;
  }
}

// Single-session saver removed: the per-mode slots in sessions.json are the
// only persistence path; the legacy file is read/cleared on migration only.

export function clearSession(): void {
  const path = sessionPath();
  if (existsSync(path)) writeFileSync(path, "{}\n");
}

// --- Per-mode device sessions (Console / Go slots) ---
// Device sign-in for either mode stores a Console-shaped session in that
// mode's slot, so account/org A can drive Console while account/org B drives
// Go. The legacy single-session.json migrates into the console slot once.

export interface ModeSessions {
  console?: ConsoleSession;
  go?: ConsoleSession;
}

export function sessionsPath(): string {
  return join(oc3Home(), "sessions.json");
}

function validConsoleSession(value: unknown): value is ConsoleSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ConsoleSession>;
  return session.mode === "console"
    && typeof session.accessToken === "string" && session.accessToken !== ""
    && typeof session.refreshToken === "string" && session.refreshToken !== ""
    && typeof session.server === "string" && session.server !== "";
}

export function loadSessions(): ModeSessions {
  const path = sessionsPath();
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ModeSessions>;
      return {
        ...(validConsoleSession(value.console) ? { console: value.console } : {}),
        ...(validConsoleSession(value.go) ? { go: value.go } : {}),
      };
    } catch {
      return {};
    }
  }
  // Legacy migration: the pre-slot single session becomes the console slot;
  // the old file is cleared once so the persisted layout matches.
  const legacy = loadSession();
  if (!legacy) return {};
  const migrated: ModeSessions = { console: legacy };
  saveSessions(migrated);
  clearSession();
  return migrated;
}

export function saveSessions(sessions: ModeSessions): void {
  ensureHome();
  writeFileSync(sessionsPath(), `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(sessionsPath(), 0o600); } catch { /* best effort */ }
}

export function saveModeSession(mode: OpenCodeMode, session: ConsoleSession): void {
  saveSessions({ ...loadSessions(), [mode]: session });
}

export function clearModeSession(mode: OpenCodeMode): void {
  saveSessions({ ...loadSessions(), [mode]: undefined });
}

export function loadState<T extends object>(fallback: T): T {
  const path = statePath();
  if (!existsSync(path)) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function saveState<T extends object>(state: T): void {
  ensureHome();
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}


// --- OpenCode service keys (Console / Go) ---
// Upstream merged the standalone Zen gateway into Console, so the per-mode
// service-account keys are `console` (pay-as-you-go, served by the historical
// /zen/v1 path) and `go` (subscription). Old keys.json blobs stored the
// Console service key under the legacy `zen` slot and are migrated on load.

export interface ServiceKeys {
  console?: string;
  go?: string;
}

export function keysPath(): string {
  return join(oc3Home(), "keys.json");
}

export function loadKeys(): ServiceKeys {
  const path = keysPath();
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceKeys> & { zen?: unknown };
    const console = typeof value.console === "string" && value.console ? value.console : undefined;
    const go = typeof value.go === "string" && value.go ? value.go : undefined;
    // Versions before the Console transition stored the Console service-account
    // key under the legacy `zen` slot. Rewrite the blob once so persisted state
    // matches the current shape.
    if (!console && typeof value.zen === "string" && value.zen.trim()) {
      const migrated: ServiceKeys = { console: value.zen.trim(), ...(go ? { go } : {}) };
      saveKeys(migrated);
      return migrated;
    }
    return {
      ...(console ? { console } : {}),
      ...(go ? { go } : {}),
    };
  } catch {
    return {};
  }
}

export function saveKeys(keys: ServiceKeys): void {
  ensureHome();
  writeFileSync(keysPath(), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(keysPath(), 0o600); } catch { /* best effort */ }
}

export function clearKeys(): void {
  const path = keysPath();
  if (existsSync(path)) writeFileSync(path, "{}\n");
}

// --- Sectioned model catalog cache (v3) ---
// models.json keeps one array per backend: console (org-scoped /api/config for
// device sessions, public /models discovery otherwise) and go (public gateway
// catalog), with per-section refresh timestamps.
// v2 stored the pay-as-you-go gateway under `zen`; such blobs are remapped to
// the console section on load (org entries win when both exist).

export type CatalogSection = "console" | "go";

export interface CatalogCache {
  console: unknown[];
  go: unknown[];
  updatedAt: Partial<Record<CatalogSection, number>>;
}

function emptyCatalogCache(): CatalogCache {
  return { console: [], go: [], updatedAt: {} };
}

export function loadCatalogCache(): CatalogCache {
  const path = modelsPath();
  if (!existsSync(path)) return emptyCatalogCache();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 3) {
      const record = value as Record<string, unknown>;
      return {
        console: Array.isArray(record.console) ? record.console : [],
        go: Array.isArray(record.go) ? record.go : [],
        updatedAt: typeof record.updatedAt === "object" && record.updatedAt !== null && !Array.isArray(record.updatedAt)
          ? record.updatedAt as Partial<Record<CatalogSection, number>>
          : {},
      };
    }
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 2) {
      const record = value as Record<string, unknown>;
      const consoleModels = Array.isArray(record.console) ? record.console : [];
      const legacyModels = Array.isArray(record.zen) ? record.zen : [];
      return {
        console: consoleModels.length ? consoleModels : legacyModels,
        go: Array.isArray(record.go) ? record.go : [],
        updatedAt: {},
      };
    }
    return emptyCatalogCache();
  } catch {
    return emptyCatalogCache();
  }
}

export function saveCatalogSection(section: CatalogSection, models: unknown[], updatedAt: number = Date.now()): void {
  ensureHome();
  const cache = loadCatalogCache();
  cache[section] = models;
  cache.updatedAt = { ...cache.updatedAt, [section]: updatedAt };
  writeFileSync(modelsPath(), `${JSON.stringify({ version: 2, ...cache }, null, 2)}\n`);
}
