import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureHome, oc3Home } from "./store";

export const KEYS = ["model_catalog_json", "openai_base_url"] as const;
export type OverrideKey = (typeof KEYS)[number];

export interface CodexOverrides {
  model_catalog_json: string;
  openai_base_url: string;
}

// `previous` holds each key's original TOML value text, quotes and comments
// included, or null when the key was absent. Backups written before version 2
// stored parsed strings instead; readBackup converts those.
interface Backup {
  previous: Partial<Record<OverrideKey, string | null>>;
}

interface BackupFile {
  version: 2;
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
  const unreadable = new Error(`oc3 backup at ${path} is unreadable; restore config.toml by hand, then delete this file`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw unreadable;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unreadable;
  const record = value as { version?: unknown; previous?: unknown };
  if (!record.previous || typeof record.previous !== "object" || Array.isArray(record.previous)) throw unreadable;
  const previous: Backup["previous"] = {};
  for (const key of KEYS) {
    const stored = (record.previous as Record<string, unknown>)[key];
    if (stored === undefined) continue;
    if (stored !== null && typeof stored !== "string") throw unreadable;
    previous[key] = stored === null || record.version === 2 ? stored : JSON.stringify(stored);
  }
  return { previous };
}

function writeBackup(backup: Backup | undefined): void {
  ensureHome();
  if (!backup) {
    rmSync(backupPath(), { force: true });
    return;
  }
  const file: BackupFile = { version: 2, previous: backup.previous };
  writeFileAtomic(backupPath(), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

function writeFileAtomic(path: string, content: string, defaultMode: number): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : defaultMode;
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temp, content, { mode });
  renameSync(temp, target);
}

// A top-level `key = value` line is a bare or quoted key followed by "=".
const KEY_LINE = /^\s*"?([A-Za-z0-9_-]+)"?\s*=/;

interface ScanState {
  depth: number;
  multiline?: '"""' | "'''";
}

// Tracks bracket depth and string state across one line. Keeps a multi-line
// array or string open so its continuation lines are never read as keys or
// table headers.
function advance(line: string, state: ScanState): ScanState {
  let { depth, multiline } = state;
  let index = 0;
  while (index < line.length) {
    if (multiline) {
      const close = line.indexOf(multiline, index);
      if (close === -1) return { depth, multiline };
      index = close + 3;
      multiline = undefined;
      continue;
    }
    const char = line[index];
    if (char === "#") break;
    if (line.startsWith('"""', index)) {
      multiline = '"""';
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multiline = "'''";
      index += 3;
      continue;
    }
    if (char === '"') {
      index = endOfBasicString(line, index + 1);
      continue;
    }
    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      index = close === -1 ? line.length : close + 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    index += 1;
  }
  return { depth, multiline };
}

function endOfBasicString(line: string, start: number): number {
  let index = start;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === '"') return index + 1;
    index += 1;
  }
  return line.length;
}

interface TopLevelSpan {
  key: OverrideKey;
  start: number;
  end: number;
  raw: string;
}

interface TopLevel {
  spans: TopLevelSpan[];
  tableIndex: number;
}

function isOverrideKey(name: string): name is OverrideKey {
  return (KEYS as readonly string[]).includes(name);
}

function scanTopLevel(lines: readonly string[]): TopLevel {
  const spans: TopLevelSpan[] = [];
  let state: ScanState = { depth: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const topLevel = state.depth === 0 && !state.multiline;
    if (topLevel && /^\s*\[/.test(line)) return { spans, tableIndex: index };
    const match = topLevel ? KEY_LINE.exec(line) : null;
    if (match && isOverrideKey(match[1] ?? "")) {
      const start = index;
      state = advance(line, state);
      let end = index;
      while ((state.depth > 0 || state.multiline) && end + 1 < lines.length) {
        end += 1;
        state = advance(lines[end] ?? "", state);
      }
      const text = lines.slice(start, end + 1).join("\n");
      spans.push({ key: match[1] as OverrideKey, start, end: end + 1, raw: text.slice(text.indexOf("=") + 1).trim() });
      index = end;
      continue;
    }
    state = advance(line, state);
  }
  return { spans, tableIndex: lines.length };
}

/** The parsed value of a TOML basic or literal string; undefined for anything else. */
export function parseStringValue(raw: string): string | undefined {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!match) return undefined;
    try {
      return JSON.parse(`"${match[1] ?? ""}"`) as string;
    } catch {
      return undefined;
    }
  }
  if (text.startsWith("'")) {
    const close = text.indexOf("'", 1);
    return close === -1 ? undefined : text.slice(1, close);
  }
  return undefined;
}

function rawValues(content: string): Partial<Record<OverrideKey, string>> {
  const result: Partial<Record<OverrideKey, string>> = {};
  for (const span of scanTopLevel(content.split("\n")).spans) result[span.key] = span.raw;
  return result;
}

function parsedValues(content: string): Partial<Record<OverrideKey, string>> {
  const result: Partial<Record<OverrideKey, string>> = {};
  const raw = rawValues(content);
  for (const key of KEYS) {
    const value = raw[key] === undefined ? undefined : parseStringValue(raw[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}

/**
 * Sets (raw TOML value text) or removes (null) top-level override keys. Keys
 * already present are edited in place; absent ones are inserted before the
 * first table. Everything else in the file is kept byte-for-byte.
 */
function rewriteKeys(content: string, values: Partial<Record<OverrideKey, string | null>>): string {
  const lines = content.split("\n");
  const { spans, tableIndex } = scanTopLevel(lines);
  const edits: LineEdit[] = [];
  const seen = new Set<OverrideKey>();
  for (const span of spans) {
    seen.add(span.key);
    const value = values[span.key];
    if (value === undefined) continue;
    edits.push({ start: span.start, end: span.end, lines: value === null ? [] : [`${span.key} = ${value}`] });
  }
  const inserts = KEYS.filter((key) => !seen.has(key) && typeof values[key] === "string")
    .map((key) => `${key} = ${values[key]}`);
  if (!edits.length && !inserts.length) return content;
  const result = [...lines];
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result.splice(edit.start, edit.end - edit.start, ...edit.lines);
  }
  if (inserts.length && tableIndex < lines.length) {
    const shift = edits.reduce((total, edit) => total + edit.lines.length - (edit.end - edit.start), 0);
    result.splice(tableIndex + shift, 0, ...inserts);
  } else if (inserts.length) {
    while (result.length && result[result.length - 1] === "") result.pop();
    result.push(...inserts, "");
  }
  return result.join("\n");
}

function readConfig(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeConfig(path: string, content: string): void {
  writeFileAtomic(path, content, 0o644);
}

export function applyCodexOverrides(overrides: CodexOverrides): { changed: boolean; backupCreated: boolean } {
  const path = codexConfigPath();
  const original = readConfig(path);
  const current = parsedValues(original);
  if (current.model_catalog_json === overrides.model_catalog_json && current.openai_base_url === overrides.openai_base_url) {
    return { changed: false, backupCreated: false };
  }
  const backupCreated = !readBackup();
  if (backupCreated) {
    const raw = rawValues(original);
    writeBackup({
      previous: {
        model_catalog_json: raw.model_catalog_json ?? null,
        openai_base_url: raw.openai_base_url ?? null,
      },
    });
  }
  const updated = rewriteKeys(original, {
    model_catalog_json: JSON.stringify(overrides.model_catalog_json),
    openai_base_url: JSON.stringify(overrides.openai_base_url),
  });
  if (updated === original) return { changed: false, backupCreated };
  writeConfig(path, updated);
  return { changed: true, backupCreated };
}

export function restoreCodexOverrides(): { changed: boolean; hadBackup: boolean } {
  const backup = readBackup();
  if (!backup) return { changed: false, hadBackup: false };
  const path = codexConfigPath();
  let changed = false;
  if (existsSync(path)) {
    const original = readFileSync(path, "utf8");
    const updated = rewriteKeys(original, backup.previous);
    if (updated !== original) {
      writeConfig(path, updated);
      changed = true;
    }
  }
  writeBackup(undefined);
  return { changed, hadBackup: true };
}

export function overridesApplied(overrides: CodexOverrides): boolean {
  const path = codexConfigPath();
  if (!existsSync(path)) return false;
  const current = parsedValues(readFileSync(path, "utf8"));
  return current.model_catalog_json === overrides.model_catalog_json
    && current.openai_base_url === overrides.openai_base_url;
}
