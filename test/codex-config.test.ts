import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { applyCodexOverrides, overridesApplied, restoreCodexOverrides } from "../src/codex-config";
import { tempRoot } from "./helpers";

const TMP = tempRoot("oc3-codex-config-test");
const CODEX_HOME = `${TMP}/codex-home`;
const OC3_HOME_DIR = `${TMP}/oc3-home`;
const savedEnv: Record<string, string | undefined> = {
  CODEX_HOME: process.env.CODEX_HOME,
  OC3_HOME: process.env.OC3_HOME,
};
const OVERRIDES = {
  model_catalog_json: "/tmp/oc3-home/codex-models.json",
  openai_base_url: "http://127.0.0.1:8788/v1",
};

const OLLAMA_LIKE = `model = "glm-5.3-flash:cloud"

model_catalog_json = "/Users/someone/.codex/ollama-launch-models.json"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"

[desktop]
keepRemoteControlAwakeWhilePluggedIn = true
`;

const EMPTY_KEYS = `model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[desktop]
keepRemoteControlAwakeWhilePluggedIn = true
`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CODEX_HOME, { recursive: true });
  mkdirSync(OC3_HOME_DIR, { recursive: true });
  process.env.CODEX_HOME = CODEX_HOME;
  process.env.OC3_HOME = OC3_HOME_DIR;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configText(): string {
  return readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
}

describe("applyCodexOverrides", () => {
  test("replaces existing ollama values and backs them up", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    const result = applyCodexOverrides(OVERRIDES);
    expect(result.changed).toBe(true);
    expect(result.backupCreated).toBe(true);
    const updated = configText();
    expect(updated).toContain(`model_catalog_json = "${OVERRIDES.model_catalog_json}"`);
    expect(updated).toContain(`openai_base_url = "${OVERRIDES.openai_base_url}"`);
    expect(updated).toContain('model = "glm-5.3-flash:cloud"');
    expect(updated).toContain("[desktop]");
    const backup = JSON.parse(readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8"));
    expect(backup.previous.model_catalog_json).toBe('"/Users/someone/.codex/ollama-launch-models.json"');
    expect(backup.previous.openai_base_url).toBe('"http://127.0.0.1:11434/api/codex/v1"');
  });

  test("inserts keys when absent and removes them on restore", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, EMPTY_KEYS);
    applyCodexOverrides(OVERRIDES);
    const updated = configText();
    const keyIndex = updated.indexOf("model_catalog_json");
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeLessThan(updated.indexOf("[desktop]"));
    restoreCodexOverrides();
    expect(configText()).toBe(EMPTY_KEYS);
  });

  test("is idempotent and does not clobber the backup", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    applyCodexOverrides(OVERRIDES);
    const backupAfterFirst = readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8");
    const second = applyCodexOverrides(OVERRIDES);
    expect(second.changed).toBe(false);
    expect(second.backupCreated).toBe(false);
    expect(readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8")).toBe(backupAfterFirst);
    expect(overridesApplied(OVERRIDES)).toBe(true);
  });

  test("leaves in-table keys untouched and adds a top-level key", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, `model = "x"

[desktop]
openai_base_url = "http://inside-table"
`);
    applyCodexOverrides(OVERRIDES);
    expect(configText()).toContain('openai_base_url = "http://inside-table"');
    expect(overridesApplied(OVERRIDES)).toBe(true);
    restoreCodexOverrides();
    expect(overridesApplied(OVERRIDES)).toBe(false);
  });

  test("keeps the original backup when the port changes between applies", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    applyCodexOverrides(OVERRIDES);
    const second = applyCodexOverrides({ ...OVERRIDES, openai_base_url: "http://127.0.0.1:9999/v1" });
    expect(second.backupCreated).toBe(false);
    expect(configText()).toContain('openai_base_url = "http://127.0.0.1:9999/v1"');
    restoreCodexOverrides();
    expect(configText()).toBe(OLLAMA_LIKE);
  });

  test("recognizes single-quoted (literal) values and restores them exactly", () => {
    const literal = `openai_base_url = 'http://127.0.0.1:11434/v1' # ollama
model = "x"
`;
    writeFileSync(`${CODEX_HOME}/config.toml`, literal);
    applyCodexOverrides(OVERRIDES);
    expect(configText()).toContain(`openai_base_url = "${OVERRIDES.openai_base_url}"`);
    restoreCodexOverrides();
    expect(configText()).toBe(literal);
  });

  test("does not read a bracket-leading continuation line as a table header", () => {
    const multiline = `list = [
  "a",
  [1, 2],
]
openai_base_url = "http://127.0.0.1:11434/v1"
`;
    writeFileSync(`${CODEX_HOME}/config.toml`, multiline);
    applyCodexOverrides(OVERRIDES);
    const updated = configText();
    expect(updated.match(/openai_base_url/g)).toHaveLength(1);
    expect(updated).toContain(`openai_base_url = "${OVERRIDES.openai_base_url}"`);
    restoreCodexOverrides();
    expect(configText()).toBe(multiline);
  });

  test("handles escaped quotes and backslashes in values", () => {
    const escaped = `model_catalog_json = "C:\\\\dir \\"q\\"\\\\x.json"
`;
    writeFileSync(`${CODEX_HOME}/config.toml`, escaped);
    applyCodexOverrides(OVERRIDES);
    restoreCodexOverrides();
    expect(configText()).toBe(escaped);
    writeFileSync(`${CODEX_HOME}/config.toml`, escaped);
    expect(overridesApplied({ ...OVERRIDES, model_catalog_json: 'C:\\dir "q"\\x.json' })).toBe(false);
    applyCodexOverrides({ ...OVERRIDES, model_catalog_json: 'C:\\dir "q"\\x.json' });
    expect(overridesApplied({ ...OVERRIDES, model_catalog_json: 'C:\\dir "q"\\x.json' })).toBe(true);
  });

  test("creates config.toml when it is missing and removes the keys on restore", () => {
    applyCodexOverrides(OVERRIDES);
    expect(overridesApplied(OVERRIDES)).toBe(true);
    const result = restoreCodexOverrides();
    expect(result.hadBackup).toBe(true);
    expect(result.changed).toBe(true);
    expect(configText().trim()).toBe("");
  });

  test("writes through a symlinked config.toml and keeps the link", () => {
    const real = `${CODEX_HOME}/dotfiles-config.toml`;
    writeFileSync(real, EMPTY_KEYS);
    symlinkSync(real, `${CODEX_HOME}/config.toml`);
    applyCodexOverrides(OVERRIDES);
    expect(lstatSync(`${CODEX_HOME}/config.toml`).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(`openai_base_url = "${OVERRIDES.openai_base_url}"`);
  });

  test("a corrupt backup is an error, not a silent first apply", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    writeFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "{ not json");
    expect(() => applyCodexOverrides(OVERRIDES)).toThrow(/unreadable/);
    expect(configText()).toBe(OLLAMA_LIKE);
  });
});

describe("restoreCodexOverrides", () => {
  test("restores ollama values byte-for-byte and clears backup", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    applyCodexOverrides(OVERRIDES);
    const result = restoreCodexOverrides();
    expect(result.changed).toBe(true);
    expect(configText()).toBe(OLLAMA_LIKE);
    expect(readBackupFile()).toBeUndefined();
    const again = restoreCodexOverrides();
    expect(again.changed).toBe(false);
    expect(again.hadBackup).toBe(false);
  });

  test("reports no change when the overrides were already removed by hand", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, EMPTY_KEYS);
    applyCodexOverrides(OVERRIDES);
    writeFileSync(`${CODEX_HOME}/config.toml`, EMPTY_KEYS);
    const result = restoreCodexOverrides();
    expect(result.hadBackup).toBe(true);
    expect(result.changed).toBe(false);
    expect(configText()).toBe(EMPTY_KEYS);
  });

  test("restores a legacy backup that stored parsed values", () => {
    writeFileSync(`${OC3_HOME_DIR}/codex-backup.json`, JSON.stringify({
      previous: { model_catalog_json: "/legacy/models.json", openai_base_url: null },
    }));
    writeFileSync(`${CODEX_HOME}/config.toml`, `model_catalog_json = "${OVERRIDES.model_catalog_json}"\n${EMPTY_KEYS}`);
    restoreCodexOverrides();
    expect(configText()).toBe(`model_catalog_json = "/legacy/models.json"\n${EMPTY_KEYS}`);
  });
});

function readBackupFile(): string | undefined {
  try {
    return readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8");
  } catch {
    return undefined;
  }
}
