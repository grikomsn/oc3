import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleSession } from "./protocol";

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
  if (existsSync(path)) writeFileSync(path, "");
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

export function loadCachedModels<T>(): T[] {
  const path = modelsPath();
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export function saveCachedModels(models: unknown[]): void {
  ensureHome();
  writeFileSync(modelsPath(), `${JSON.stringify(models, null, 2)}\n`);
}
