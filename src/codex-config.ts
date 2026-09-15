import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, oc3Home } from "./store";

export const KEYS = ["model_catalog_json", "openai_base_url"] as const;
export type OverrideKey = (typeof KEYS)[number];

export interface CodexOverrides {
  model_catalog_json: string;
  openai_base_url: string;
}

interface Backup {
  previous: Partial<Record<OverrideKey, string | null>>;
}

export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  return join(home, "config.toml");
}

function backupPath(): string {
  return join(oc3Home(), "codex-backup.json");
}

export function readBackup(): Backup | undefined {
  const path = backupPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Backup;
    if (!value || typeof value !== "object" || typeof value.previous !== "object") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeBackup(backup: Backup | undefined): void {
  ensureHome();
  if (!backup) {
    rmSync(backupPath(), { force: true });
    return;
  }
  writeFileSync(backupPath(), `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
}

function keyLineRegex(key: OverrideKey): RegExp {
  return new RegExp(`^\\s*"?${key}"?\\s*=`);
}

function extractTopLevelValues(content: string): Partial<Record<OverrideKey, string>> {
  const result: Partial<Record<OverrideKey, string>> = {};
  for (const line of content.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    for (const key of KEYS) {
      const match = keyLineRegex(key).exec(line);
      if (match) {
        const value = /"([^"]*)"/.exec(line)?.[1];
        if (value !== undefined) result[key] = value;
      }
    }
  }
  return result;
}

function rewriteKeyLines(content: string, values: Partial<Record<OverrideKey, string | null>>): string {
  const lines = content.split("\n");
  const firstHeaderIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstHeaderIndex === -1 ? lines.length : firstHeaderIndex;
  const pending = new Map(Object.entries(values)) as Map<OverrideKey, string | null>;
  const seen = new Set<OverrideKey>();

  for (let index = 0; index < topLevelEnd; index += 1) {
    const line = lines[index] ?? "";
    for (const key of KEYS) {
      if (!keyLineRegex(key).test(line)) continue;
      seen.add(key);
      const value = pending.get(key);
      if (value === undefined) continue;
      if (value === null) {
        lines.splice(index, 1);
        return rewriteKeyLines(lines.join("\n"), values);
      }
      lines[index] = `${key} = "${value}"`;
      pending.delete(key);
    }
  }

  const inserts: string[] = [];
  for (const key of KEYS) {
    if (seen.has(key)) continue;
    const value = pending.get(key);
    if (value === undefined || value === null) continue;
    inserts.push(`${key} = "${value}"`);
    pending.delete(key);
  }
  if (inserts.length) {
    if (firstHeaderIndex === -1) {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(...inserts, "");
    } else {
      lines.splice(firstHeaderIndex, 0, ...inserts);
    }
  }
  return lines.join("\n");
}

export function applyCodexOverrides(overrides: CodexOverrides): { changed: boolean; backupCreated: boolean } {
  const path = codexConfigPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const current = extractTopLevelValues(original);
  if (current.model_catalog_json === overrides.model_catalog_json && current.openai_base_url === overrides.openai_base_url) {
    return { changed: false, backupCreated: false };
  }
  const backupCreated = !readBackup();
  if (backupCreated) {
    writeBackup({
      previous: {
        model_catalog_json: current.model_catalog_json ?? null,
        openai_base_url: current.openai_base_url ?? null,
      },
    });
  }
  const updated = rewriteKeyLines(original, {
    model_catalog_json: overrides.model_catalog_json,
    openai_base_url: overrides.openai_base_url,
  });
  if (updated !== original) writeFileSync(path, updated);
  return { changed: true, backupCreated };
}

export function restoreCodexOverrides(): { changed: boolean; hadBackup: boolean } {
  const backup = readBackup();
  if (!backup) return { changed: false, hadBackup: false };
  const path = codexConfigPath();
  if (existsSync(path)) {
    const original = readFileSync(path, "utf8");
    const updated = rewriteKeyLines(original, backup.previous);
    if (updated !== original) writeFileSync(path, updated);
  }
  writeBackup(undefined);
  return { changed: true, hadBackup: true };
}

export function overridesApplied(overrides: CodexOverrides): boolean {
  if (!existsSync(codexConfigPath())) return false;
  const current = extractTopLevelValues(readFileSync(codexConfigPath(), "utf8"));
  return current.model_catalog_json === overrides.model_catalog_json
    && current.openai_base_url === overrides.openai_base_url;
}

export function extractTopLevelValuesForTest(content: string): Partial<Record<OverrideKey, string>> {
  return extractTopLevelValues(content);
}
