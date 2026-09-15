import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const TMP = "/tmp/oc3-start-stop-test";
const CODEX_HOME = `${TMP}/codex-home`;
const OC3_HOME_DIR = `${TMP}/oc3-home`;
const PORT = 8895;
const MODEL_ID = "acme/fast-model";

const ORIGINAL_CONFIG = `model = "glm-5.3-flash:cloud"

model_catalog_json = "/Users/someone/.codex/ollama-launch-models.json"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"

[desktop]
keepRemoteControlAwakeWhilePluggedIn = true
`;


async function waitFor<T>(poll: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await poll();
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  throw new Error("waitFor timed out");
}

function runCli(args: string[]): ReturnType<typeof spawn> {
  return spawn("bun", ["src/cli.ts", ...args], {
    env: {
      ...process.env,
      CODEX_HOME,
      OC3_HOME: OC3_HOME_DIR,
      OC3_TEST_TOKEN: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("oc3 start/stop lifecycle", () => {
  test("applies overrides, serves, then restores config", async () => {
    mkdirSync(CODEX_HOME, { recursive: true });
    mkdirSync(OC3_HOME_DIR, { recursive: true });
    writeFileSync(`${CODEX_HOME}/config.toml`, ORIGINAL_CONFIG);
    writeFileSync(`${OC3_HOME_DIR}/models.json`, JSON.stringify([
      {
        id: MODEL_ID,
        rawModelId: "fast-model",
        providerId: "acme",
        name: "Fast",
        contextLength: 128000,
        maxOutputTokens: 8192,
        reasoning: false,
        imageInput: false,
        toolCalling: true,
        endpoint: "chat-completions",
        baseUrl: "http://127.0.0.1:1/v1",
      },
    ]));

    let startOutput = "";
    const start = runCli(["start", "--port", String(PORT), "--no-launch"]);
    
    start.stdout?.on("data", (chunk: Buffer) => { startOutput += chunk.toString(); });
    start.stderr?.on("data", (chunk: Buffer) => { startOutput += chunk.toString(); });

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`);
        return response.ok ? await response.json() : undefined;
      } catch {
        return undefined;
      }
    }, 15_000);

    const updated = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(updated).toContain(`openai_base_url = "http://127.0.0.1:${PORT}/v1"`);
    expect(updated).toContain(`model_catalog_json = "${OC3_HOME_DIR}/codex-models.json"`);
    expect(existsSync(`${OC3_HOME_DIR}/codex-backup.json`)).toBe(true);

    const stop = runCli(["stop"]);
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}/health`);
        return undefined;
      } catch {
        return true;
      }
    }, 15_000);
    const restored = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    expect(restored).toBe(ORIGINAL_CONFIG);
    expect(existsSync(`${OC3_HOME_DIR}/codex-backup.json`)).toBe(false);

    void startOutput;
  }, 30_000);
});


