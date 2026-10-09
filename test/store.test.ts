import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loadCatalogCache, modelsPath, saveCatalogSection } from "../src/store";
import { readJson, tempRoot } from "./helpers";

const HOME = tempRoot("oc3-store-test");

function setHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  process.env.OC3_HOME = HOME;
}

const savedEnv = process.env.OC3_HOME;

beforeAll(setHome);
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.OC3_HOME;
  else process.env.OC3_HOME = savedEnv;
});

function model(providerId: string, rawModelId: string): Record<string, unknown> {
  return { id: `${providerId}/${rawModelId}`, rawModelId, providerId, name: rawModelId };
}

describe("sectioned model catalog cache", () => {
  test("save then load keeps models and per-section updatedAt", () => {
    setHome();
    saveCatalogSection("console", [model("acme", "fast")], 1000);
    saveCatalogSection("go", [model("opencode-go", "kimi")], 2000);
    expect(readJson<{ version: number }>(modelsPath()).version).toBe(3);
    expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
    expect(loadCatalogCache()).toEqual({
      console: [model("acme", "fast")],
      go: [model("opencode-go", "kimi")],
      updatedAt: { console: 1000, go: 2000 },
    });
    saveCatalogSection("console", [], 3000);
    expect(loadCatalogCache().updatedAt).toEqual({ console: 3000, go: 2000 });
    expect(loadCatalogCache().go).toEqual([model("opencode-go", "kimi")]);
  });

  test("v2 blobs still load, remapping zen into console without timestamps", () => {
    setHome();
    writeFileSync(modelsPath(), JSON.stringify({ version: 2, console: [], zen: [model("opencode", "gpt")], go: [], updatedAt: { zen: 111 } }));
    const cache = loadCatalogCache();
    expect(cache.console).toEqual([model("opencode", "gpt")]);
    expect(cache.updatedAt).toEqual({});
  });

  test("entries without a string id and providerId are dropped on load", () => {
    setHome();
    const good = model("acme", "fast");
    const bad = [{ id: "acme/x" }, { providerId: "acme" }, { id: 7, providerId: "acme" }, null, "acme/y"];
    writeFileSync(modelsPath(), JSON.stringify({ version: 3, console: [good, ...bad], go: [...bad, model("opencode-go", "kimi")], updatedAt: {} }));
    const cache = loadCatalogCache();
    expect(cache.console).toEqual([good]);
    expect(cache.go).toEqual([model("opencode-go", "kimi")]);
  });

  test("the v2 zen fallback applies the same entry validation", () => {
    setHome();
    const good = model("opencode", "gpt");
    writeFileSync(modelsPath(), JSON.stringify({ version: 2, console: [], zen: [good, { id: "opencode/x" }], go: [{ providerId: "opencode-go" }] }));
    const cache = loadCatalogCache();
    expect(cache.console).toEqual([good]);
    expect(cache.go).toEqual([]);
  });
});
