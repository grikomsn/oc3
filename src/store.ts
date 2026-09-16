import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleSession } from "./protocol";

export type CatalogSection = "console" | "zen" | "go";

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

export function saveSession(session: ConsoleSession): void {
  ensureHome();
  writeFileSync(sessionPath(), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(sessionPath(), 0o600); } catch { /* best effort */ }
}

export function clearSession(): void {
  const path = sessionPath();
  if (existsSync(path)) writeFileSync(path, "{}\n");
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


// --- OpenCode gateway (Zen / Go) API keys ---

export interface GatewayKeys {
  zen?: string;
  go?: string;
}

export function keysPath(): string {
  return join(oc3Home(), "keys.json");
}

export function loadKeys(): GatewayKeys {
  const path = keysPath();
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GatewayKeys>;
    return {
      ...(typeof value.zen === "string" && value.zen ? { zen: value.zen } : {}),
      ...(typeof value.go === "string" && value.go ? { go: value.go } : {}),
    };
  } catch {
    return {};
  }
}

export function saveKeys(keys: GatewayKeys): void {
  ensureHome();
  writeFileSync(keysPath(), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(keysPath(), 0o600); } catch { /* best effort */ }
}

export function clearKeys(): void {
  const path = keysPath();
  if (existsSync(path)) writeFileSync(path, "{}\n");
}

// --- Sectioned model catalog cache (v2) ---
// models.json keeps one array per backend: console (org-scoped /api/config),
// zen and go (public gateway catalogs), with per-section refresh timestamps.

export interface CatalogCache {
  console: unknown[];
  zen: unknown[];
  go: unknown[];
  updatedAt: Partial<Record<CatalogSection, number>>;
}

function emptyCatalogCache(): CatalogCache {
  return { console: [], zen: [], go: [], updatedAt: {} };
}

export function loadCatalogCache(): CatalogCache {
  const path = modelsPath();
  if (!existsSync(path)) return emptyCatalogCache();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 2) {
      const record = value as Record<string, unknown>;
      return {
        console: Array.isArray(record.console) ? record.console : [],
        zen: Array.isArray(record.zen) ? record.zen : [],
        go: Array.isArray(record.go) ? record.go : [],
        updatedAt: typeof record.updatedAt === "object" && record.updatedAt !== null && !Array.isArray(record.updatedAt)
          ? record.updatedAt as Partial<Record<CatalogSection, number>>
          : {},
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
