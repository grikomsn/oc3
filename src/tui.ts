import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  RGBA,
} from "@opentui/core";
import type { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { writeCodexCatalog } from "./codex-catalog";
import { launchChatGptDesktop, daemonRunning, readDaemonInfo, removeStaleDaemonFile, serveLogPath, stopDaemon } from "./daemon";
import { applyCodexOverrides, overridesApplied, readBackup, restoreCodexOverrides } from "./codex-config";
import { codexCatalogPath, loadKeys, loadState, saveKeys, saveState } from "./store";
import { fetchGatewayUsage, gatewayKeyFor } from "./zen";
import { displayName, providerLabel, sortModelsByGroup, type Oc3Model } from "./models";
import { startServer, type RequestRecord, type ServerHandle } from "./server";

interface TuiOptions {
  port: number;
  auth: OpenCodeAuth;
  /** Test seam: inject a renderer factory (see @opentui/core/testing). */
  createRenderer?: typeof createCliRenderer;
}

type ViewId = "models" | "account" | "gateway" | "proxy" | "logs";

// Theme-following palette: terminal default fg/bg plus ANSI palette slots so
// the TUI renders correctly under any terminal color scheme.
const THEME_TEXT = RGBA.defaultForeground();
const THEME_BG = RGBA.defaultBackground();
const THEME_ACCENT = RGBA.fromIndex(12); // brightBlue — titles, help heading
const THEME_GOOD = RGBA.fromIndex(10); // brightGreen — status, account badge
const THEME_WARN = RGBA.fromIndex(11); // brightYellow — action labels
const THEME_MUTED = RGBA.fromIndex(8); // brightBlack — hints, footer, dim values
const THEME_ACTIVE = RGBA.fromIndex(15); // brightWhite — active tab

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: "models", label: "Models" },
  { id: "account", label: "Account" },
  { id: "gateway", label: "Gateway" },
  { id: "proxy", label: "Proxy" },
  { id: "logs", label: "Logs" },
];

// --- pure helpers (unit-tested) ---

/**
 * Subsequence fuzzy score for `needle` against `haystack`, or undefined when
 * the needle is not a (case-insensitive) subsequence. Higher is better:
 * exact and prefix matches rank above word-start matches, which rank above
 * scattered subsequence matches; consecutive runs and small gaps adjust.
 */
export function fuzzyScore(haystack: string, needle: string): number | undefined {
  const hay = haystack.toLowerCase();
  const ned = needle.toLowerCase();
  if (!ned) return 0;
  const isWordChar = (char: string) => /[a-z0-9]/.test(char);
  let score = 0;
  let searchFrom = 0;
  let previous = -2;
  for (const char of ned) {
    const at = hay.indexOf(char, searchFrom);
    if (at === -1) return undefined;
    score += 10;
    if (at === previous + 1) score += 7;
    if (at === 0 || !isWordChar(hay[at - 1]!)) score += 5;
    score -= Math.min(3, Math.max(0, at - previous - 2));
    previous = at;
    searchFrom = at + 1;
  }
  if (hay === ned) score += 30;
  else if (hay.startsWith(ned)) score += 15;
  return score;
}

/** Mask an API key for display: `sk-1a…9f`, or "not set". */
export function maskKey(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const FUZZY_FIELDS = (model: Oc3Model): string[] => [
  model.id,
  model.name,
  displayName(model),
  model.endpoint,
  providerLabel(model),
];

/** Fuzzy filter; empty query keeps the grouped order, otherwise best score wins. */
export function filterModels(models: readonly Oc3Model[], query: string): Oc3Model[] {
  const base = sortModelsByGroup(models);
  const needle = query.trim();
  if (!needle) return base;
  return base
    .map((model, index) => {
      let score: number | undefined;
      for (const field of FUZZY_FIELDS(model)) {
        const fieldScore = fuzzyScore(field, needle);
        if (fieldScore !== undefined && (score === undefined || fieldScore > score)) score = fieldScore;
      }
      return { model, index, score };
    })
    .filter((entry) => entry.score !== undefined)
    .sort((a, b) => (b.score as number) - (a.score as number) || a.index - b.index)
    .map((entry) => entry.model);
}

export function modelDescription(model: Oc3Model): string {
  const cost = model.cost
    ? ` · $${formatCost(model.cost.input)}/${formatCost(model.cost.output)}`
    : "";
  const efforts = model.reasoningEfforts?.length ? ` · ${model.reasoningEfforts.join("/")}` : "";
  return `${model.endpoint} · ctx ${formatContextLength(model.contextLength)}${cost}${efforts}`;
}

/** Compact context length: 400k / 1.2M. */
export function formatContextLength(value: number): string {
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (value >= 1000) return `${trimZero(value / 1000)}k`;
  return String(value);
}

function trimZero(value: number): string {
  return String(Number(value.toFixed(1)));
}

function formatCost(value: number | undefined): string {
  return value === undefined ? "?" : String(Number(value.toFixed(2)));
}

export function formatRequestRecord(record: RequestRecord): string {
  const time = new Date(record.at).toLocaleTimeString("en-GB");
  const model = record.model.length > 36 ? `${record.model.slice(0, 35)}…` : record.model;
  return `${time}  ${String(record.status)}  ${String(record.ms).padStart(5)}ms  ${model}`;
}

export function usageLines(usage: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [nested, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${nested}: ${stringifyScalar(nestedValue)}`);
      }
    } else {
      lines.push(`${key}: ${stringifyScalar(value)}`);
    }
  }
  return lines.length ? lines : ["(no usage data returned)"];
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "number" && !Number.isInteger(value)) return String(Math.round(value * 100) / 100);
  return String(value);
}

// --- shell ---

export async function runTui(options: TuiOptions): Promise<void> {
  const renderer = await (options.createRenderer ?? createCliRenderer)({ exitOnCtrlC: true });
  const auth = options.auth;
  const state = loadState<{ defaultModel?: string }>({});
  let models: Oc3Model[] = [];
  let visibleModels: Oc3Model[] = [];
  let active: ViewId = "models";
  let helpOpen = false;
  let handle: ServerHandle | undefined;
  let statusLine = "";
  const timers: ReturnType<typeof setInterval>[] = [];
  // Deferred focus timers: focusing within the same keypress event leaks the
  // trigger character into the freshly focused input, so focus lands next tick.
  const focusTimers: ReturnType<typeof setTimeout>[] = [];

  function focusLater(target: InputRenderable): void {
    focusTimers.push(setTimeout(() => {
      try {
        target.focus();
      } catch { /* renderer already destroyed */ }
    }, 0));
  }

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    backgroundColor: THEME_BG,
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);

  // Header: brand + account.
  const header = new BoxRenderable(renderer, { flexDirection: "column", paddingLeft: 1, paddingRight: 1 });
  const titleLine = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", width: "100%" });
  const title = new TextRenderable(renderer, { content: "oc3 — OpenCode Console proxy", fg: THEME_ACCENT });
  const accountBadge = new TextRenderable(renderer, { content: "", fg: THEME_GOOD });
  titleLine.add(title);
  titleLine.add(accountBadge);
  header.add(titleLine);

  // Tab strip: one TextRenderable per view for per-tab coloring.
  const tabRow = new BoxRenderable(renderer, { flexDirection: "row", width: "100%" });
  const tabs = new Map<ViewId, TextRenderable>();
  for (let index = 0; index < VIEWS.length; index += 1) {
    const view = VIEWS[index]!;
    const tab = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
    tabs.set(view.id, tab);
    tabRow.add(tab);
  }
  header.add(tabRow);
  root.add(header);

  // Content area: one box per view, visibility toggled.
  const content = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%" });
  root.add(content);

  // Status + footer.
  const status = new TextRenderable(renderer, { content: "", fg: THEME_GOOD });
  root.add(status);
  const footer = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  root.add(footer);

  // --- models view ---
  const modelsView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1 });
  const filterInput = new InputRenderable(renderer, {
    placeholder: "filter models (Enter applies, Esc closes)…",
    maxLength: 60,
    width: "100%",
  });
  filterInput.visible = false;
  const modelSelect = new SelectRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: false,
  });
  modelsView.add(filterInput);
  modelsView.add(modelSelect);
  content.add(modelsView);

  modelSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const model = visibleModels[index];
    if (!model) return;
    state.defaultModel = model.id;
    saveState(state);
    statusLine = `Default model: ${model.id}`;
    renderModels();
  });

  let filterOpen = false;
  filterInput.on(InputRenderableEvents.INPUT, () => {
    applyModelFilter();
  });
  filterInput.on(InputRenderableEvents.ENTER, () => {
    closeFilter(false);
  });

  function openFilter(): void {
    filterOpen = true;
    filterInput.visible = true;
    focusLater(filterInput);
  }

  function closeFilter(clearText: boolean): void {
    filterOpen = false;
    if (clearText) filterInput.value = "";
    filterInput.visible = false;
    filterInput.blur();
    applyModelFilter();
  }

  function applyModelFilter(): void {
    const previous = visibleModels[modelSelect.getSelectedIndex() ?? 0]?.id;
    visibleModels = filterModels(sortModelsByGroup(models), filterInput.value);
    modelSelect.options = visibleModels.map((model) => ({
      name: `${model.id === state.defaultModel ? "● " : "  "}${displayName(model)}`,
      description: modelDescription(model),
      value: model.id,
    }));
    const kept = visibleModels.findIndex((model) => model.id === previous);
    modelSelect.setSelectedIndex(kept >= 0 ? kept : 0);
  }

  function renderModels(): void {
    applyModelFilter();
    if (!models.length) {
      statusLine = "No models cached — press r to refresh.";
    }
  }

  async function loadModels(refresh: boolean): Promise<void> {
    try {
      if (refresh) {
        statusLine = "Refreshing model catalog…";
        refreshStatus();
        const refreshed = await refreshModels(auth);
        models = refreshed.models;
        await writeCodexCatalog(models);
        statusLine = `Loaded ${models.length} models; codex catalog written.${
          refreshed.errors.length ? ` Warnings: ${refreshed.errors.join("; ")}` : ""
        }`;
      } else {
        models = availableModels();
      }
      renderModels();
    } catch (error) {
      models = availableModels();
      renderModels();
      statusLine = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    refreshStatus();
  }

  // --- account view ---
  const accountView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  const accountInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const orgSelect = new SelectRenderable(renderer, { flexGrow: 1, width: "100%", showDescription: true, showScrollIndicator: true });
  const loginPanel = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: THEME_BG, width: "100%", paddingLeft: 1 });
  loginPanel.visible = false;
  const loginLines = [
    new TextRenderable(renderer, { content: "", fg: THEME_WARN }),
    new TextRenderable(renderer, { content: "", fg: THEME_TEXT }),
    new TextRenderable(renderer, { content: "", fg: THEME_MUTED }),
  ];
  for (const line of loginLines) loginPanel.add(line);
  accountView.add(accountInfo);
  accountView.add(loginPanel);
  accountView.add(orgSelect);
  content.add(accountView);

  let orgs: Array<{ id: string; name: string }> = [];
  let loginActive = false;

  orgSelect.on(SelectRenderableEvents.ITEM_SELECTED, async (index: number) => {
    const org = orgs[index];
    if (!org) return;
    try {
      await auth.selectOrganization(org.id);
      statusLine = `Active org: ${org.name} (${org.id})`;
      await loadModels(false);
    } catch (error) {
      statusLine = `Org switch failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    renderAccount();
    refreshStatus();
  });

  function renderAccount(): void {
    const session = auth.getSession();
    if (!session) {
      accountInfo.content = "Not signed in. Press l to sign in (device code).";
      orgSelect.options = [];
      orgs = [];
    } else {
      accountInfo.content = `Signed in: ${session.email}  ·  active org: ${session.orgName ?? session.orgId ?? "none"}  ·  server: ${session.server}`;
      orgs = session.orgs;
      orgSelect.options = orgs.map((org) => ({
        name: `${org.id === session.orgId ? "● " : "  "}${org.name}`,
        description: org.id,
        value: org.id,
      }));
    }
    refreshStatus();
  }

  async function startLogin(): Promise<void> {
    if (loginActive) return;
    loginActive = true;
    loginPanel.visible = true;
    try {
      const device = await auth.requestDeviceCode();
      loginLines[0]!.content = `Sign in: ${device.verificationUrl}`;
      loginLines[1]!.content = `User code: ${device.userCode}`;
      try {
        const proc = Bun.spawn(["open", device.verificationUrl], { stdout: "ignore", stderr: "ignore" });
        void proc.exited;
      } catch { /* macOS only; the URL is shown above */ }
      const session = await auth.completeDeviceSignIn(device, undefined, (seconds) => {
        loginLines[2]!.content = `Waiting for authorization… ${seconds}s`;
      });
      if (session.orgs.length > 1) {
        statusLine = `Signed in as ${session.email}; ${session.orgs.length} orgs available — Enter to switch.`;
      } else {
        statusLine = `Signed in as ${session.email}.`;
      }
    } catch (error) {
      statusLine = `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    loginActive = false;
    loginPanel.visible = false;
    renderAccount();
    await loadModels(false);
  }

  function logout(): void {
    auth.signOut();
    statusLine = "Signed out.";
    renderAccount();
  }

  // --- gateway view ---
  const gatewayView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  const keysInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const editLabel = new TextRenderable(renderer, { content: "", fg: THEME_WARN });
  const keyInput = new InputRenderable(renderer, {
    placeholder: "press z (zen) or g (go) to paste a key…",
    maxLength: 200,
    width: "100%",
  });
  const storedLabel = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  const usageBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%" });
  const usageTitle = new TextRenderable(renderer, { content: "Go quota (u refreshes):", fg: THEME_TEXT });
  const usageText = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  usageBox.add(usageTitle);
  usageBox.add(usageText);
  gatewayView.add(keysInfo);
  gatewayView.add(editLabel);
  gatewayView.add(keyInput);
  gatewayView.add(storedLabel);
  gatewayView.add(usageBox);
  content.add(gatewayView);

  let gatewayEdit: "zen" | "go" | undefined;
  let usageLoading = false;

  keyInput.on(InputRenderableEvents.ENTER, (value: string) => {
    const key = value.trim();
    if (gatewayEdit && key) {
      const target = gatewayEdit;
      saveKeys({ ...loadKeys(), [target]: key });
      statusLine = `${target === "zen" ? "Zen" : "Go"} key saved (${maskKey(key)}).`;
    }
    cancelGatewayEdit();
    renderGateway();
  });

  function editGatewayKey(target: "zen" | "go"): void {
    gatewayEdit = target;
    keyInput.value = "";
    keyInput.placeholder = `paste ${target} key — Enter saves, Esc cancels…`;
    focusLater(keyInput);
    renderGateway();
  }

  function switchGatewayEdit(): void {
    editGatewayKey(gatewayEdit === "zen" ? "go" : "zen");
  }

  function cancelGatewayEdit(): void {
    gatewayEdit = undefined;
    keyInput.value = "";
    keyInput.placeholder = "press z (zen) or g (go) to paste a key…";
    keyInput.blur();
  }

  function renderGateway(): void {
    const keys = loadKeys();
    const envKey = process.env.OPENCODE_API_KEY;
    const fromEnv = !keys.zen && !keys.go && envKey ? " (env)" : "";
    keysInfo.content = "gateway keys — get one at https://opencode.ai/auth · z: paste zen · g: paste go · tab: switch · enter: save · esc: cancel · c: clear all";
    const show = (value: string | undefined) => maskKey(value);
    storedLabel.content = `zen: ${show(gatewayKeyFor("opencode", keys))}${fromEnv}  ·  go: ${show(gatewayKeyFor("opencode-go", keys))}${fromEnv}  ·  stored in OC3_HOME/keys.json (0600)`;
    editLabel.content = gatewayEdit
      ? `→ pasting ${gatewayEdit.toUpperCase()} key  (current: ${show(gatewayEdit === "zen" ? keys.zen ?? keys.go ?? envKey : keys.go ?? keys.zen ?? envKey)})`
      : "";
    refreshStatus();
  }

  async function loadUsage(): Promise<void> {
    if (usageLoading) return;
    const key = gatewayKeyFor("opencode-go", loadKeys());
    if (!key) {
      usageText.content = "No Go key configured — press g to set one.";
      return;
    }
    usageLoading = true;
    usageText.content = "Loading Go usage…";
    try {
      const usage = await fetchGatewayUsage(key);
      usageText.content = usageLines(usage).join("\n");
    } catch (error) {
      usageText.content = `Usage lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    usageLoading = false;
  }

  // --- proxy view ---
  const proxyView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  const proxyInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const overridesInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const requestsTitle = new TextRenderable(renderer, { content: "Recent /responses requests:", fg: THEME_TEXT });
  const requestsText = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  proxyView.add(proxyInfo);
  proxyView.add(overridesInfo);
  proxyView.add(requestsTitle);
  proxyView.add(requestsText);
  content.add(proxyView);

  function daemonState(): { running: boolean; port?: number; pid?: number } {
    removeStaleDaemonFile();
    const info = readDaemonInfo();
    return info && daemonRunning(info) ? { running: true, port: info.port, pid: info.pid } : { running: false };
  }

  function renderProxy(): void {
    const daemon = daemonState();
    const proxy = daemon.running
      ? `proxy: daemon on port ${daemon.port} (pid ${daemon.pid})`
      : handle
        ? `proxy: http://127.0.0.1:${handle.port} · requests: ${handle.requestCount()}`
        : "proxy: stopped";
    proxyInfo.content = proxy;
    const applied = overridesApplied(overrides());
    const backup = readBackup();
    overridesInfo.content = `config: ${applied ? "overridden" : "original"} · backup: ${backup ? "present" : "none"} · s: server/daemon  e: overrides  d: boot ChatGPT desktop`;
    const records = handle ? [...handle.recentRequests()].reverse().slice(0, 8) : [];
    requestsText.content = records.length ? records.map(formatRequestRecord).join("\n") : handle ? "(no requests yet)" : "(in-process server not running — attach state shown above)";
    refreshStatus();
  }

  function overrides() {
    return { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${options.port}/v1` };
  }

  async function toggleServer(): Promise<void> {
    const daemon = daemonState();
    if (handle) {
      handle.stop();
      handle = undefined;
      statusLine = "In-process server stopped.";
    } else if (daemon.running) {
      const stopped = stopDaemon();
      const restored = restoreCodexOverrides();
      statusLine = `${stopped ? "Daemon stopped." : "Daemon stop failed."}${restored.changed ? " Config restored." : ""}`;
    } else {
      try {
        handle = await startServer({ port: options.port, auth });
        statusLine = `Server started on port ${handle.port}.`;
      } catch (error) {
        statusLine = `Server failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    renderProxy();
  }

  async function toggleOverrides(): Promise<void> {
    try {
      if (overridesApplied(overrides())) {
        const restored = restoreCodexOverrides();
        statusLine = restored.changed ? "Config overrides restored." : "No overrides to restore.";
      } else {
        const result = applyCodexOverrides(overrides());
        statusLine = result.changed ? "Config overrides applied." : "Config overrides already applied.";
      }
    } catch (error) {
      statusLine = `Config toggle failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    renderProxy();
  }

  function bootDesktop(): void {
    const launched = launchChatGptDesktop();
    statusLine = launched ? "Booted ChatGPT desktop." : "Could not launch ChatGPT desktop (open -a ChatGPT).";
    refreshStatus();
  }

  // --- logs view ---
  const logsView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1 });
  const logsHint = new TextRenderable(renderer, { content: "serve.log tail — r: reload", fg: THEME_MUTED });
  const logsBox = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", stickyScroll: true, stickyStart: "bottom", backgroundColor: THEME_BG });
  const logsText = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  logsBox.add(logsText);
  logsView.add(logsHint);
  logsView.add(logsBox);
  content.add(logsView);

  function loadLogs(): void {
    const path = serveLogPath();
    const file = Bun.file(path);
    file.text().then((content) => {
      const lines = content.split("\n");
      const tail = lines.slice(Math.max(0, lines.length - 300)).join("\n");
      logsText.content = tail || "(log file is empty)";
    }).catch(() => {
      logsText.content = "No serve log yet. Start the daemon with `oc3 start`, or run the in-process server here (Proxy view, s).";
    });
  }

  // --- view switching ---

  function setView(next: ViewId): void {
    active = next;
    helpOpen = false;
    modelsView.visible = next === "models";
    accountView.visible = next === "account";
    gatewayView.visible = next === "gateway";
    proxyView.visible = next === "proxy";
    logsView.visible = next === "logs";
    if (next === "account") renderAccount();
    if (next === "gateway") { renderGateway(); void loadUsage(); }
    if (next === "proxy") renderProxy();
    if (next === "logs") loadLogs();
    if (next !== "gateway" && gatewayEdit) {
      cancelGatewayEdit();
    }
    if (next !== "models" && filterOpen) closeFilter(true);
    renderTabs();
    refreshStatus();
  }

  function renderTabs(): void {
    for (let index = 0; index < VIEWS.length; index += 1) {
      const view = VIEWS[index]!;
      const tab = tabs.get(view.id)!;
      const isActive = view.id === active;
      tab.content = `[${index + 1}] ${isActive ? view.label.toUpperCase() : view.label}  `;
      tab.fg = isActive ? THEME_ACTIVE : THEME_MUTED;
    }
  }

  function refreshStatus(): void {
    const session = auth.getSession();
    accountBadge.content = session ? `${session.email} · ${session.orgName ?? session.orgId ?? "no org"}` : "not signed in";
    status.content = statusLine;
    const footers: Record<ViewId, string> = {
      models: "j/k move · Enter set default · r refresh · / filter · [1-5] views · ? help · q quit",
      account: "j/k move · Enter switch org · l sign in · x sign out · [1-5] views · ? help · q quit",
      gateway: "z/g paste key · tab switch · Enter save · c clear · u quota · [1-5] views · ? help · q quit",
      proxy: "s server/daemon · e overrides · d boot desktop · [1-5] views · ? help · q quit",
      logs: "r reload · [1-5] views · ? help · q quit",
    };
    footer.content = footers[active];
  }

  function toggleHelp(): void {
    helpOpen = !helpOpen;
    if (helpOpen) {
      statusLine = "";
      helpBox.visible = true;
      modelsView.visible = false;
      accountView.visible = false;
      gatewayView.visible = false;
      proxyView.visible = false;
      logsView.visible = false;
    } else {
      helpBox.visible = false;
      setView(active);
      return;
    }
    refreshStatus();
  }

  const helpBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  helpBox.visible = false;
  content.add(helpBox);
  helpBox.add(new TextRenderable(renderer, { content: "oc3 — keybindings", fg: THEME_ACCENT }));
  for (const line of [
    "[1-5] or tab        switch views (Models, Account, Gateway, Proxy, Logs)",
    "j / k               move selection (Shift for fast scroll)",
    "Enter               activate the highlighted item",
    "Models:  r refresh catalog · / filter models",
    "Account: l device-code sign in · x sign out",
    "Gateway: z/g edit zen/go key · c clear keys · u refresh Go quota",
    "Proxy:   s toggle in-process server / stop daemon · e toggle config overrides · d boot ChatGPT desktop",
    "Logs:    r reload serve.log tail",
    "?                  toggle this help",
    "q or Esc           quit",
  ]) {
    helpBox.add(new TextRenderable(renderer, { content: line, fg: THEME_MUTED }));
  }

  // Poll timers: proxy request feed, logs tail.
  timers.push(setInterval(() => {
    if (active === "proxy" && !helpOpen) renderProxy();
  }, 1000));
  timers.push(setInterval(() => {
    if (active === "logs" && !helpOpen) loadLogs();
  }, 2000));

  renderer.keyInput.on("keypress", (key) => {
    // Text inputs own the keyboard while open.
    if (filterOpen) {
      if (key.name === "escape") closeFilter(true);
      return;
    }
    if (gatewayEdit) {
      if (key.name === "escape") {
        cancelGatewayEdit();
        renderGateway();
      }
      else if (key.name === "tab") switchGatewayEdit();
      return;
    }
    if (helpOpen) {
      helpOpen = false;
      helpBox.visible = false;
      setView(active);
      return;
    }
    if (key.name === "q") {
      for (const timer of timers) clearInterval(timer);
      for (const timer of focusTimers) clearTimeout(timer);
      handle?.stop();
      renderer.destroy();
      return;
    }
    if (key.name === "escape") {
      // Esc on Models toggles help off / quits only via q; here: quit.
      for (const timer of timers) clearInterval(timer);
      for (const timer of focusTimers) clearTimeout(timer);
      handle?.stop();
      renderer.destroy();
      return;
    }
    if (key.name === "tab") {
      const index = VIEWS.findIndex((view) => view.id === active);
      setView(VIEWS[(index + 1) % VIEWS.length]!.id);
      return;
    }
    const viewIndex = ["1", "2", "3", "4", "5"].indexOf(key.sequence ?? "");
    if (viewIndex >= 0) {
      setView(VIEWS[viewIndex]!.id);
      return;
    }
    if (key.name === "?" || key.sequence === "?") {
      toggleHelp();
      return;
    }
    switch (active) {
      case "models": {
        if (key.name === "down" || key.name === "j") { modelSelect.moveDown(key.shift ? 5 : 1); return; }
        if (key.name === "up" || key.name === "k") { modelSelect.moveUp(key.shift ? 5 : 1); return; }
        if (key.name === "return" || key.name === "enter") { modelSelect.selectCurrent(); return; }
        if (key.name === "r") { void loadModels(true); return; }
        if (key.sequence === "/") { openFilter(); return; }
        if (key.name === "g") { modelSelect.setSelectedIndex(0); return; }
        if (key.name === "G") { modelSelect.setSelectedIndex(Math.max(visibleModels.length - 1, 0)); return; }
        return;
      }
      case "account": {
        if (key.name === "down" || key.name === "j") { orgSelect.moveDown(); return; }
        if (key.name === "up" || key.name === "k") { orgSelect.moveUp(); return; }
        if (key.name === "return" || key.name === "enter") { orgSelect.selectCurrent(); return; }
        if (key.name === "l") { void startLogin(); return; }
        if (key.name === "x") { logout(); return; }
        return;
      }
      case "gateway": {
        if (key.name === "z") { editGatewayKey("zen"); return; }
        if (key.name === "g") { editGatewayKey("go"); return; }
        if (key.name === "c") { clearGatewayKey(); return; }
        if (key.name === "u") { void loadUsage(); return; }
        return;
      }
      case "proxy": {
        if (key.name === "s") { void toggleServer(); return; }
        if (key.name === "e") { void toggleOverrides(); return; }
        if (key.name === "d") { bootDesktop(); return; }
        return;
      }
      case "logs": {
        if (key.name === "r") { loadLogs(); return; }
        return;
      }
    }
  });

  function clearGatewayKey(): void {
    saveKeys({});
    statusLine = "Stored gateway keys cleared.";
    renderGateway();
  }

  // Boot: load models, attach to or start the proxy, land on Models.
  await loadModels(false);
  const daemon = daemonState();
  if (!daemon.running) {
    try {
      handle = await startServer({ port: options.port, auth });
      statusLine = `Server started on port ${handle.port}.`;
    } catch (error) {
      statusLine = `Server failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    statusLine = `Attached to running daemon on port ${daemon.port}.`;
  }
  renderTabs();
  setView("models");
}
