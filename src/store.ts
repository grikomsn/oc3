import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConsoleOrg, ConsoleSession, OpenCodeMode } from "./protocol";

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
  mkdirSync(oc3Home(), { recursive: true, mode: 0o700 });
}

/** Writes a same-directory temp file created 0600, then renames it over the target. */
function writeFileAtomic(path: string, contents: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Reads a state file as a JSON object. A file that is not one is moved aside so
 * the next save cannot silently overwrite it; its contents are never logged.
 */
function readStateRecord(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* quarantined below */ }
  quarantine(path, text);
  return undefined;
}

function quarantine(path: string, text: string): void {
  const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    writeFileSync(aside, text, { mode: 0o600, flag: "wx" });
    rmSync(path, { force: true });
    console.error(`Warning: ${basename(path)} is not valid JSON; moved aside to ${basename(aside)}`);
  } catch {
    console.error(`Warning: ${basename(path)} is not valid JSON and could not be moved aside`);
  }
}

export function loadSession(): ConsoleSession | undefined {
  const path = sessionPath();
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validConsoleSession(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Single-session saver removed: the per-mode slots in sessions.json are the
// only persistence path; the legacy file is read/cleared on migration only.

export function clearSession(): void {
  const path = sessionPath();
  if (existsSync(path)) writeFileAtomic(path, "{}\n");
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
    && typeof session.server === "string" && isAllowedServer(session.server)
    && Array.isArray(session.orgs) && session.orgs.every(validOrg)
    && typeof session.expiresAt === "number" && Number.isFinite(new Date(session.expiresAt).getTime());
}

function validOrg(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const org = value as Partial<ConsoleOrg>;
  return typeof org.id === "string" && typeof org.name === "string";
}

/** Console servers must be https; plain http is only accepted for loopback dev overrides. */
export function isAllowedServer(server: string): boolean {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

export function loadSessions(): ModeSessions {
  const path = sessionsPath();
  if (existsSync(path)) {
    const value = readStateRecord(path);
    if (!value) return {};
    return {
      ...(validConsoleSession(value.console) ? { console: value.console } : {}),
      ...(validConsoleSession(value.go) ? { go: value.go } : {}),
    };
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
  writeFileAtomic(sessionsPath(), `${JSON.stringify(sessions, null, 2)}\n`);
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
  writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
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
  const value = readStateRecord(path);
  if (!value) return {};
  const console = typeof value.console === "string" && value.console ? value.console : undefined;
  const go = typeof value.go === "string" && value.go ? value.go : undefined;
  // Versions before the Console transition stored the Console service-account
  // key under the legacy `zen` slot. Rewrite the blob once so persisted state
  // matches the current shape.
  if (!console && typeof value.zen === "string" && value.zen.trim()) {
    const migrated: ServiceKeys = { console: value.zen.trim(), ...(go ? { go } : {}) };
    try { saveKeys(migrated); } catch { /* best effort; the migrated key still works this run */ }
    return migrated;
  }
  return {
    ...(console ? { console } : {}),
    ...(go ? { go } : {}),
  };
}

export function saveKeys(keys: ServiceKeys): void {
  ensureHome();
  writeFileAtomic(keysPath(), `${JSON.stringify(keys, null, 2)}\n`);
}

export function clearKeys(): void {
  const path = keysPath();
  if (existsSync(path)) writeFileAtomic(path, "{}\n");
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

/** Keeps only entries the catalog consumers can index: an object with string id and providerId. */
function cacheModels(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const model = entry as Record<string, unknown>;
    return typeof model.id === "string" && typeof model.providerId === "string";
  });
}

export function loadCatalogCache(): CatalogCache {
  const path = modelsPath();
  if (!existsSync(path)) return emptyCatalogCache();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 3) {
      const record = value as Record<string, unknown>;
      return {
        console: cacheModels(record.console),
        go: cacheModels(record.go),
        updatedAt: typeof record.updatedAt === "object" && record.updatedAt !== null && !Array.isArray(record.updatedAt)
          ? record.updatedAt as Partial<Record<CatalogSection, number>>
          : {},
      };
    }
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 2) {
      const record = value as Record<string, unknown>;
      const consoleModels = cacheModels(record.console);
      const legacyModels = cacheModels(record.zen);
      return {
        console: consoleModels.length ? consoleModels : legacyModels,
        go: cacheModels(record.go),
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
  writeFileAtomic(modelsPath(), `${JSON.stringify({ version: 3, ...cache }, null, 2)}\n`);
}
