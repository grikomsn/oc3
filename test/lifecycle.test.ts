import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAll } from "../src/lifecycle";
import { freePort, tempRoot } from "./helpers";

const ORIGINAL = `model = "glm-5.3-flash:cloud"

model_catalog_json = "/Users/someone/.codex/ollama-launch-models.json"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"
`;

let root: string;
let codexHome: string;
let oc3Home: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = tempRoot("oc3-lifecycle");
  rmSync(root, { recursive: true, force: true });
  codexHome = join(root, "codex");
  oc3Home = join(root, "oc3");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(oc3Home, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), ORIGINAL);
  for (const key of ["CODEX_HOME", "OC3_HOME"]) saved[key] = process.env[key];
  process.env.CODEX_HOME = codexHome;
  process.env.OC3_HOME = oc3Home;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function overrides(port: number) {
  return { model_catalog_json: join(oc3Home, "codex-models.json"), openai_base_url: `http://127.0.0.1:${port}/v1` };
}

describe("startAll", () => {
  test("a child that exits before answering rolls the overrides back", async () => {
    const port = freePort();
    const outcome = await startAll({
      port,
      cliEntry: join(root, "missing-entry.ts"),
      overrides: overrides(port),
      healthTimeoutMs: 8_000,
    });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(ORIGINAL);
    expect(existsSync(join(oc3Home, "codex-backup.json"))).toBe(false);
  }, 15_000);

  test("another process answering on the port is not treated as our proxy", async () => {
    const port = freePort();
    const entry = join(root, "idle-child.ts");
    writeFileSync(entry, "await Bun.sleep(60_000);\n");
    const impostor = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true, pid: 1 }),
    });
    try {
      const outcome = await startAll({ port, cliEntry: entry, overrides: overrides(port), healthTimeoutMs: 2_000 });
      expect(outcome).toEqual({ ok: false, reason: "unhealthy" });
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(ORIGINAL);
      expect(existsSync(join(oc3Home, "daemon.json"))).toBe(false);
    } finally {
      impostor.stop(true);
    }
  }, 20_000);
});
