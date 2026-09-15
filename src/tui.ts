import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";
import type { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { writeCodexCatalog } from "./codex-catalog";
import { startServer, type ServerHandle } from "./server";
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
  const account = new TextRenderable(renderer, { content: "", fg: "#9BE49B" });
  const serverStatus = new TextRenderable(renderer, { content: "", fg: "#F0C674" });
  const listTitle = new TextRenderable(renderer, { content: "Models (up/down select, Enter to set default, r refresh):", fg: "#C5C8D6" });
  const listBox = new BoxRenderable(renderer, { flexDirection: "column", height: 14, backgroundColor: "#101014" });
  const listLines: TextRenderable[] = [];
  for (let index = 0; index < 24; index += 1) {
    const line = new TextRenderable(renderer, { content: "", fg: "#888899" });
    listLines.push(line);
    listBox.add(line);
  }
  const footer = new TextRenderable(renderer, { content: "s: toggle server  r: refresh models  q: quit", fg: "#707880" });
  const status = new TextRenderable(renderer, { content: "", fg: "#9BE494" });

  root.add(header);
  root.add(account);
  root.add(serverStatus);
  root.add(listTitle);
  root.add(listBox);
  root.add(status);
  root.add(footer);

  function renderList(): void {
    const visible = models.slice(0, listLines.length);
    listLines.forEach((line, index) => {
      const model = visible[index];
      if (!model) {
        line.content = "";
        return;
      }
      const marker = model.id === state.defaultModel ? "*" : index === selected ? ">" : " ";
      line.content = `${marker} ${model.id.padEnd(44)} ${model.endpoint.padEnd(16)} ctx=${model.contextLength}`;
      line.fg = index === selected ? "#FFFFFF" : model.id === state.defaultModel ? "#9BE494" : "#888899";
      line.bg = index === selected ? "#22304a" : undefined;
    });
    if (!models.length) {
      listLines[0]!.content = "  (no models cached — press r to refresh)";
      listLines[0]!.fg = "#888888";
    }
  }

  function refreshStatus(): void {
    const session = options.auth.getSession();
    account.content = session ? `account: ${session.email}  org: ${session.orgName ?? session.orgId ?? "none"}` : "not signed in — exit and run: oc3 login";
    serverStatus.content = handle ? `server: http://127.0.0.1:${handle.port}  requests: ${handle.requestCount()}` : "server: stopped";
    status.content = statusLine;
  }

  async function loadModels(refresh: boolean): Promise<void> {
    try {
      if (refresh) {
        statusLine = "Refreshing model catalog from Console...";
        renderList();
        models = await refreshModels(options.auth);
      } else {
        models = availableModels();
      }
      await writeCodexCatalog(models);
      const index = models.findIndex((model) => model.id === state.defaultModel);
      selected = index >= 0 ? index : 0;
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

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || key.name === "escape") {
      handle?.stop();
      renderer.destroy();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      selected = Math.min(selected + 1, Math.max(models.length - 1, 0));
      renderList();
      return;
    }
    if (key.name === "up" || key.name === "k") {
      selected = Math.max(selected - 1, 0);
      renderList();
      return;
    }
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
    if (key.name === "r") { void loadModels(true); return; }
  });

  await loadModels(false);
  await toggleServer();
}
