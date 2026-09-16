import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { runTui } from "../src/tui";
import { OpenCodeAuth } from "../src/auth";

const HOME = "/tmp/oc3-tui-test";
const PORT = 8921;

let mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"];
let captureFrame: () => string;
let quit: () => void;

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
  process.env.OC3_HOME = `${HOME}/.config/oc3`;
  process.env.CODEX_HOME = `${HOME}/codex`;
  writeFileSync(`${process.env.OC3_HOME}/models.json`, JSON.stringify({ version: 2, console: [
    {
      id: "acme/gpt-model",
      rawModelId: "gpt-model",
      providerId: "acme",
      name: "GPT Model",
      contextLength: 400_000,
      maxOutputTokens: 8192,
      reasoning: true,
      imageInput: false,
      toolCalling: true,
      endpoint: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
    },
  ], zen: [
    {
      id: "opencode/qwen-coder",
      rawModelId: "qwen-coder",
      providerId: "opencode",
      name: "Qwen Coder",
      contextLength: 256_000,
      maxOutputTokens: 8192,
      reasoning: true,
      imageInput: false,
      toolCalling: true,
      endpoint: "chat",
      baseUrl: "https://opencode.ai/zen/v1",
      source: "gateway",
    },
  ], go: [] }));

  const promise = runTui({
    port: PORT,
    auth: new OpenCodeAuth(),
    createRenderer: async () => {
      const test = await createTestRenderer({ width: 100, height: 30 });
      mockInput = test.mockInput;
      captureFrame = test.captureCharFrame;
      quit = () => test.renderer.destroy();
      return test.renderer;
    },
  });
  await promise;
});

afterAll(() => {
  quit?.();
  rmSync(HOME, { recursive: true, force: true });
});

describe("TUI shell", () => {
  test("boots on the Models view with grouped models and tab strip", async () => {
    await Bun.sleep(100);
    const frame = captureFrame();
    expect(frame).toContain("oc3");
    expect(frame).toContain("[1] MODELS");
    expect(frame).toContain("GPT Model [Console]");
    expect(frame).toContain("Qwen Coder [Zen]");
    expect(frame).toContain("ctx 400000");
  });

  test("switches to the Gateway view and shows key status", async () => {
    mockInput.pressKey("3");
    await Bun.sleep(100);
    const frame = captureFrame();
    expect(frame).toContain("[3] GATEWAY");
    expect(frame).toContain("gateway keys");
  });

  test("switches to the Proxy view and shows server state", async () => {
    mockInput.pressKey("4");
    await Bun.sleep(100);
    const frame = captureFrame();
    expect(frame).toContain("[4] PROXY");
    expect(frame).toContain("proxy: http://127.0.0.1:8921");
  });

  test("help overlay toggles with ?", async () => {
    mockInput.pressKey("?");
    await Bun.sleep(100);
    expect(captureFrame()).toContain("keybindings");
    mockInput.pressKey("?");
    await Bun.sleep(100);
    expect(captureFrame()).toContain("[4] PROXY");
  });
});
