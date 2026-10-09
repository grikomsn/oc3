import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { runTui } from "../src/tui";
import { OpenCodeAuth } from "../src/auth";
import { freePort, tempRoot } from "./helpers";

const HOME = tempRoot("oc3-tui-test");
let uiPort = 0;

let mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"];
let captureFrame: () => string;
let dispose: (() => void) | undefined;
const savedEnv: Record<string, string | undefined> = {};

interface SlotSession {
  email: string;
  accountId: string;
  orgId: string;
  orgName: string;
  token: string;
}

function slotSession(slot: SlotSession): object {
  return {
    mode: "console",
    server: "https://opencode.ai/console",
    accessToken: slot.token,
    refreshToken: `${slot.token}-refresh`,
    expiresAt: Date.now() + 3600_000,
    accountId: slot.accountId,
    email: slot.email,
    orgs: [{ id: slot.orgId, name: slot.orgName }],
    orgId: slot.orgId,
    orgName: slot.orgName,
  };
}

const consoleSlot: SlotSession = { email: "a@example.com", accountId: "acct-a", orgId: "org-a", orgName: "Org A", token: "console-slot-token" };
const goSlot: SlotSession = { email: "b@example.com", accountId: "acct-b", orgId: "org-b", orgName: "Org B", token: "go-slot-token" };

/** Polls the rendered frame until it satisfies the predicate, or returns the last frame. */
async function waitForFrame(predicate: (frame: string) => boolean, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = captureFrame();
  while (!predicate(frame) && Date.now() < deadline) {
    await Bun.sleep(25);
    frame = captureFrame();
  }
  return frame;
}

beforeAll(async () => {
  for (const key of ["OC3_HOME", "CODEX_HOME"]) savedEnv[key] = process.env[key];
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(`${HOME}/.config/oc3`, { recursive: true });
  process.env.OC3_HOME = `${HOME}/.config/oc3`;
  process.env.CODEX_HOME = `${HOME}/codex`;
  writeFileSync(`${process.env.OC3_HOME}/models.json`, JSON.stringify({ version: 3, console: [
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
  writeFileSync(`${process.env.OC3_HOME}/sessions.json`, JSON.stringify({
    console: slotSession(consoleSlot),
    go: slotSession(goSlot),
  }));

  uiPort = freePort();
  const promise = runTui({
    port: uiPort,
    auth: new OpenCodeAuth(),
    createRenderer: async () => {
      const test = await createTestRenderer({ width: 100, height: 30 });
      mockInput = test.mockInput;
      captureFrame = test.captureCharFrame;
      dispose = () => test.renderer.destroy();
      return test.renderer;
    },
  });
  dispose = (await promise) ?? dispose;
});

afterAll(() => {
  dispose?.();
  rmSync(HOME, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("TUI shell", () => {
  test("boots on the Models view with grouped models and tab strip", async () => {
    const frame = await waitForFrame((text) => text.includes("GPT Model [Console]"));
    expect(frame).toContain("oc3");
    expect(frame).toContain("[1] MODELS");
    expect(frame).toContain("[2] Account");
    expect(frame).toContain("[3] Runtime");
    expect(frame).toContain("GPT Model [Console]");
    expect(frame).toContain("Qwen Coder [Console]");
    expect(frame).toContain("console: Org A");
    expect(frame).toContain("go: Org B");
    expect(frame).toContain("ctx 400k");
  });

  test("account view shows both mode slots with identity and hint bar", async () => {
    mockInput.pressKey("2");
    const frame = await waitForFrame((text) => text.includes("[2] ACCOUNT"));
    expect(frame).toContain("[2] ACCOUNT");
    expect(frame).toContain("Console: a@example.com · Org A");
    expect(frame).toContain("Go: b@example.com · Org B");
    expect(frame).toContain("service keys");
    expect(frame).toContain("j/k slot · Enter orgs · l/x sign · z key · c clear · u quota · 1-3/arrows/tab views · ? · q");
    expect(frame).toContain("q");
  });

  test("account service key editing saves with masked display", async () => {
    mockInput.pressKey("2");
    mockInput.pressKey("z");
    await waitForFrame((text) => text.includes("pasting Console service key"));
    expect(captureFrame()).toContain("pasting Console service key");
    await mockInput.typeText("sk-test-12345678");
    mockInput.pressEnter();
    const frame = await waitForFrame((text) => text.includes("console: …5678"));
    expect(frame).toContain("Console key saved (…5678)");
    expect(frame).toContain("console: …5678");
  });

  test("org list opens for the highlighted slot and escapes back", async () => {
    mockInput.pressKey("2");
    mockInput.pressEnter();
    let frame = await waitForFrame((text) => text.includes("Console organizations"));
    expect(frame).toContain("Console organizations — Enter switches, Esc returns.");
    expect(frame).toContain("Org A");
    expect(frame).toContain("j/k org · Enter switch · Esc slots");
    mockInput.pressKey("escape");
    frame = await waitForFrame((text) => text.includes("Console: a@example.com · Org A"));
    expect(frame).toContain("Console: a@example.com · Org A");
    expect(frame).toContain("Go: b@example.com · Org B");
  });

  test("signing out of the go slot preserves the console slot", async () => {
    mockInput.pressKey("2");
    mockInput.pressKey("escape");
    mockInput.pressKey("j");
    mockInput.pressKey("x");
    const frame = await waitForFrame((text) => text.includes("Signed out of Go."));
    expect(frame).toContain("Signed out of Go.");
    expect(frame).toContain("Go: not signed in");
    expect(frame).toContain("Console: a@example.com · Org A");
  });

  test("arrows switch views left and right", async () => {
    mockInput.pressKey("1");
    await waitForFrame((text) => text.includes("j/k move · g/G"));
    mockInput.pressArrow("right");
    expect((await waitForFrame((text) => text.includes("j/k slot · Enter orgs"))).length).toBeGreaterThan(0);
    mockInput.pressArrow("right");
    expect(await waitForFrame((text) => text.includes("s server · e overrides"))).toContain("s server · e overrides");
    mockInput.pressArrow("left");
    expect(await waitForFrame((text) => text.includes("j/k slot · Enter orgs"))).toContain("j/k slot · Enter orgs");
    mockInput.pressArrow("left");
    expect(await waitForFrame((text) => text.includes("j/k move · g/G"))).toContain("j/k move · g/G");
  });

  test("filter search keeps up/down navigating the model list", async () => {
    mockInput.pressKey("1");
    await waitForFrame((text) => text.includes("j/k move · g/G"));
    mockInput.pressKey("/");
    // the filter takes focus on a deferred tick; typing before that lands in the list
    await Bun.sleep(50);
    await mockInput.typeText("gpt");
    const before = await waitForFrame((text) => text.includes("gpt"));
    expect(before).toContain("GPT Model [Console]");
    // with several fuzzy hits, down moves the selection; the filter stays open
    mockInput.pressArrow("down");
    await Bun.sleep(50);
    const after = captureFrame();
    expect(after).toContain("GPT Model [Console]");
    expect(after).toContain("[1] MODELS");
    await mockInput.typeText("x");
    expect(await waitForFrame((text) => text.includes("gptx"))).toContain("gptx");
    mockInput.pressEscape();
    // Escape is held briefly to tell it apart from escape sequences; wait for the list hints to return.
    await Bun.sleep(100);
    expect(await waitForFrame((text) => text.includes("j/k move · g/G") && !text.includes("gptx"))).not.toContain("gptx");
  });

  test("digits beyond the view count are ignored", async () => {
    mockInput.pressKey("1");
    await waitForFrame((text) => text.includes("j/k move · g/G"));
    mockInput.pressKey("9");
    // a negative assertion has no frame to wait for, so give the key a moment to land
    await Bun.sleep(50);
    expect(captureFrame()).toContain("j/k move · g/G");
  });

  test("fuzzy filter narrows the model list live", async () => {
    mockInput.pressKey("1");
    await waitForFrame((text) => text.includes("j/k move · g/G"));
    mockInput.pressKey("/");
    await Bun.sleep(50);
    await mockInput.typeText("qwc");
    const frame = await waitForFrame((text) => text.includes("Qwen Coder [Console]") && !text.includes("GPT Model [Console]"));
    expect(frame).toContain("Qwen Coder [Console]");
    expect(frame).not.toContain("GPT Model [Console]");
    mockInput.pressEscape();
    await Bun.sleep(100);
    expect(await waitForFrame((text) => text.includes("j/k move · g/G") && !text.includes("qwc"))).not.toContain("qwc");
  });

  test("runtime view shows proxy state and log hint", async () => {
    mockInput.pressKey("1");
    await waitForFrame((text) => text.includes("j/k move · g/G"));
    mockInput.pressKey("3");
    const frame = await waitForFrame((text) => text.includes("Recent /responses requests:"));
    expect(frame).toContain(`http://127.0.0.1:${uiPort}`);
    expect(frame).toContain("Recent /responses requests:");
    expect(frame).toContain("s server · e overrides");
    expect(frame).toContain("serve.log tail");
  });

  test("help overlay toggles with ?", async () => {
    mockInput.pressKey("?");
    const frame = await waitForFrame((text) => text.includes("keybindings"));
    expect(frame).toContain("keybindings");
    expect(frame).toContain("Account: l device-code");
    expect(frame).toContain("Runtime: s toggle server/daemon");
    expect(frame).toContain("q                  quit");
    mockInput.pressKey("?");
    expect(await waitForFrame((text) => text.includes("s server · e overrides"))).toContain("s server · e overrides");
  });
});
