import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { applyCodexOverrides, overridesApplied, restoreCodexOverrides, extractTopLevelValuesForTest } from "../src/codex-config";

const TMP = "/tmp/oc3-codex-config-test";
const CODEX_HOME = `${TMP}/codex-home`;
const OC3_HOME_DIR = `${TMP}/oc3-home`;
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
  delete process.env.CODEX_HOME;
  delete process.env.OC3_HOME;
});

describe("applyCodexOverrides", () => {
  test("replaces existing ollama values and backs them up", () => {
    const original = `${OLLAMA_LIKE}`;
    writeFileSync(`${CODEX_HOME}/config.toml`, original);
    const result = applyCodexOverrides(OVERRIDES);
    expect(result.changed).toBe(true);
    expect(result.backupCreated).toBe(true);
    const updated = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(updated).toContain(`model_catalog_json = "${OVERRIDES.model_catalog_json}"`);
    expect(updated).toContain(`openai_base_url = "${OVERRIDES.openai_base_url}"`);
    expect(updated).toContain('model = "glm-5.3-flash:cloud"');
    expect(updated).toContain("[desktop]");
    const backup = JSON.parse(readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8"));
    expect(backup.previous.model_catalog_json).toBe("/Users/someone/.codex/ollama-launch-models.json");
    expect(backup.previous.openai_base_url).toBe("http://127.0.0.1:11434/api/codex/v1");
  });

  test("inserts keys when absent and removes them on restore", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, EMPTY_KEYS);
    applyCodexOverrides(OVERRIDES);
    const updated = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(updated).toContain('model_catalog_json = "/tmp/oc3-home/codex-models.json"');
    const keyIndex = updated.indexOf("model_catalog_json");
    const tableIndex = updated.indexOf("[desktop]");
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeLessThan(tableIndex);
    restoreCodexOverrides();
    const restored = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(restored).toBe(EMPTY_KEYS);
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
    const content = `model = "x"

[desktop]
openai_base_url = "http://inside-table"
`;
    writeFileSync(`${CODEX_HOME}/config.toml`, content);
    applyCodexOverrides(OVERRIDES);
    const updated = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(updated).toContain('openai_base_url = "http://inside-table"');
    expect(extractTopLevelValuesForTest(updated).openai_base_url).toBe(OVERRIDES.openai_base_url);
  });
});

describe("restoreCodexOverrides", () => {
  test("restores ollama values byte-for-byte and clears backup", () => {
    writeFileSync(`${CODEX_HOME}/config.toml`, OLLAMA_LIKE);
    applyCodexOverrides(OVERRIDES);
    const result = restoreCodexOverrides();
    expect(result.changed).toBe(true);
    expect(readFileSync(`${CODEX_HOME}/config.toml`, "utf8")).toBe(OLLAMA_LIKE);
    expect(readBackupFile()).toBeUndefined();
    const again = restoreCodexOverrides();
    expect(again.changed).toBe(false);
    expect(again.hadBackup).toBe(false);
  });
});

function readBackupFile(): string | undefined {
  try {
    return readFileSync(`${OC3_HOME_DIR}/codex-backup.json`, "utf8");
  } catch {
    return undefined as unknown as string;
  }
}
