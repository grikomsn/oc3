import { BoxRenderable, InputRenderable, InputRenderableEvents, TextRenderable, createCliRenderer } from "@opentui/core";
import type { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { writeCodexCatalog } from "./codex-catalog";
import { startServer, type ServerHandle } from "./server";
import { applyCodexOverrides, overridesApplied, restoreCodexOverrides } from "./codex-config";
import { codexCatalogPath, loadKeys, saveKeys } from "./store";
import { gatewayKeyFor } from "./zen";
import { loadState, saveState } from "./store";
import type { Oc3Model } from "./models";

interface TuiOptions {
  port: number;
  auth: OpenCodeAuth;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const state = loadState<{ defaultModel?: string }>({});
  let models: Oc3Model[] = [];
  let selected = 0;
  let handle: ServerHandle | undefined;
  let statusLine = "";

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: "#101014",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);

  const header = new TextRenderable(renderer, { content: "oc3 — OpenCode Console proxy", fg: "#8AB4FF" });
  const PAD = 100;
  const pad = (value: string): string => value.padEnd(PAD);
  const account = new TextRenderable(renderer, { content: "", fg: "#9BE49B" });
  const serverStatus = new TextRenderable(renderer, { content: "", fg: "#F0C674" });
  const gatewayStatus = new TextRenderable(renderer, { content: "", fg: "#F0C674" });
  const listTitle = new TextRenderable(renderer, { content: "Models:", fg: "#C5C8D6" });
  const listBox = new BoxRenderable(renderer, { flexDirection: "column", height: 12, backgroundColor: "#101014" });
  const listLines: TextRenderable[] = [];
  for (let index = 0; index < 10; index += 1) {
    const line = new TextRenderable(renderer, { content: "", fg: "#888899" });
    listLines.push(line);
    listBox.add(line);
  }
  const footer = new TextRenderable(renderer, { content: "s: toggle server  e: toggle config overrides  r: refresh models  a: api keys  q: quit".padEnd(100), fg: "#707880" });
  const status = new TextRenderable(renderer, { content: "", fg: "#9BE494" });
  const keysPanel = new BoxRenderable(renderer, { flexDirection: "column", height: 4, backgroundColor: "#161620", width: "100%" });
  keysPanel.visible = false;
  const keysInput = new InputRenderable(renderer, {
    placeholder: "Paste OpenCode API key (shared Zen/Go) — Enter saves, Esc closes…",
    maxLength: 200,
    width: "100%",
  });
  keysPanel.add(keysInput);
  root.add(keysPanel);
  root.add(header);
  root.add(account);
  root.add(serverStatus);
  root.add(gatewayStatus);
  root.add(listTitle);
  root.add(listBox);
  root.add(status);
  root.add(footer);

  function trimNumber(value: number): string {
    return String(Number(value.toFixed(2)));
  }

  function renderList(): void {
    const viewportHeight = 10;
    const total = models.length;
    let start = 0;
    if (total > viewportHeight) {
      start = Math.max(0, Math.min(selected - Math.floor(viewportHeight / 2), total - viewportHeight));
    }
    const visible = models.slice(start, start + viewportHeight);
    listLines.forEach((line, index) => {
      const model = visible[index];
      if (!model) {
        line.content = "";
        return;
      }
      const marker = model.id === state.defaultModel ? "*" : index + start === selected ? ">" : " ";
      const cost = model.cost?.input !== undefined ? ` $${trimNumber(model.cost.input)}` : "";
      line.content = `${marker} ${model.id.padEnd(44)} ${model.endpoint.padEnd(16)} ctx=${model.contextLength}${cost}`.padEnd(PAD);
      line.fg = index + start === selected ? "#FFFFFF" : model.id === state.defaultModel ? "#9BE494" : "#888899";
      line.bg = index + start === selected ? "#22304a" : undefined;
    });
    if (!total) {
      listLines[0]!.content = "  (no models cached — press r to refresh)".padEnd(PAD);
      listLines[0]!.fg = "#888888";
    }
    listTitle.content = `Models ${total ? `${selected + 1}/${total}` : "(0)"} — up/down move, Enter sets default, r refreshes:`.padEnd(PAD);
  }

  let keysPanelOpen = false;

  function openKeysPanel(): void {
    keysPanelOpen = true;
    keysPanel.visible = true;
    keysInput.value = "";
    keysInput.focus();
    refreshStatus();
  }

  function closeKeysPanel(): void {
    keysPanelOpen = false;
    keysPanel.visible = false;
    refreshStatus();
  }

  keysInput.on(InputRenderableEvents.ENTER, (value: string) => {
    const key = value.trim();
    if (key) {
      const current = loadKeys();
      saveKeys({ ...current, zen: key });
      statusLine = "Gateway key saved (shared Zen/Go). Go-only keys: oc3 keys --go <key>.";
    }
    closeKeysPanel();
  });

  function refreshStatus(): void {
    const session = options.auth.getSession();
    account.content = pad(session ? `account: ${session.email}  org: ${session.orgName ?? session.orgId ?? "none"}` : "not signed in — exit and run: oc3 login");
    const applied = overridesApplied({ model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${options.port}/v1` });
    serverStatus.content = pad(`${handle ? `server: http://127.0.0.1:${handle.port}  requests: ${handle.requestCount()}` : "server: stopped"}  config: ${applied ? "overridden" : "original"}`);
    const keys = loadKeys();
    const show = (value: string) => value ? "set" : "not set";
    gatewayStatus.content = pad(`gateway keys:  zen: ${show(gatewayKeyFor("opencode", keys))}  go: ${show(gatewayKeyFor("opencode-go", keys))}  (oc3 keys --set <key>)`);
    status.content = pad(statusLine);
  }

  async function loadModels(refresh: boolean): Promise<void> {
    try {
      if (refresh) {
        statusLine = "Refreshing model catalog...";
        renderList();
        const refreshed = await refreshModels(options.auth);
        models = refreshed.models;
        statusLine = `Loaded ${models.length} models; codex catalog written.${refreshed.errors.length ? ` Warnings: ${refreshed.errors.join("; ")}` : ""}`;
      } else {
        models = availableModels();
      }
      await writeCodexCatalog(models);
      const index = models.findIndex((model) => model.id === state.defaultModel);
      selected = index >= 0 ? index : 0;
      if (selected >= models.length) selected = Math.max(0, models.length - 1);
      statusLine = refresh ? `Loaded ${models.length} models; codex catalog written.` : `Loaded ${models.length} cached models.`;
    } catch (error) {
      models = availableModels();
      statusLine = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    renderList();
    refreshStatus();
  }

  async function toggleServer(): Promise<void> {
    if (handle) {
      handle.stop();
      handle = undefined;
      statusLine = "Server stopped.";
    } else {
      try {
        handle = await startServer({ port: options.port, auth: options.auth });
        statusLine = `Server started on port ${handle.port}.`;
      } catch (error) {
        statusLine = `Server failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    refreshStatus();
  }

  async function toggleOverrides(): Promise<void> {
    try {
      const overrides = { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${options.port}/v1` };
      if (overridesApplied(overrides)) {
        const restored = restoreCodexOverrides();
        statusLine = restored.changed ? "Config overrides restored." : "No overrides to restore.";
      } else {
        const result = applyCodexOverrides(overrides);
        statusLine = result.changed ? "Config overrides applied." : "Config overrides already applied.";
      }
    } catch (error) {
      statusLine = `Config toggle failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    refreshStatus();
  }

  renderer.keyInput.on("keypress", (key) => {
    if (keysPanelOpen) {
      if (key.name === "escape") closeKeysPanel();
      return;
    }
    if (key.name === "q" || key.name === "escape") {
      handle?.stop();
      renderer.destroy();
      return;
    }
    if (key.name === "down" || key.name === "j" || key.sequence === "\u001b[B") {
      selected = Math.min(selected + 1, Math.max(models.length - 1, 0));
      renderList();
      return;
    }
    if (key.name === "up" || key.name === "k" || key.sequence === "\u001b[A") {
      selected = Math.max(selected - 1, 0);
      renderList();
      return;
    }
    if (key.name === "a") { openKeysPanel(); return; }
    if (key.name === "g") { selected = 0; renderList(); return; }
    if (key.name === "G") { selected = Math.max(models.length - 1, 0); renderList(); return; }
    if (key.name === "return" || key.name === "enter") {
      const model = models[selected];
      if (model) {
        state.defaultModel = model.id;
        saveState(state);
        statusLine = `Default model: ${model.id}`;
        renderList();
        refreshStatus();
      }
      return;
    }
    if (key.name === "s") { void toggleServer(); return; }
    if (key.name === "e") { void toggleOverrides(); return; }
    if (key.name === "r") { void loadModels(true); return; }
  });

  await loadModels(false);
  await toggleServer();
}
