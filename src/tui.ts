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
import { existsSync } from "node:fs";
import type { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { writeCodexCatalog } from "./codex-catalog";
import { launchChatGptDesktop, daemonRunning, readDaemonInfo, readServeLogTail, removeStaleDaemonFile, serveLogPath } from "./daemon";
import { stopAll } from "./lifecycle";
import { applyCodexOverrides, overridesApplied, readBackup, restoreCodexOverrides } from "./codex-config";
import { maskKey } from "./secrets";
export { maskKey };
import { codexCatalogPath, loadKeys, loadState, saveKeys, saveState } from "./store";
import { fetchGatewayUsage, gatewayKeyFor } from "./gateway";
import { displayName, modeLabel, providerLabel, sortModelsByGroup, type Oc3Model } from "./models";
import { startServer, type RequestRecord, type ServerHandle } from "./server";
import { deviceSignIn } from "./signin";
import type { ConsoleSession, OpenCodeMode } from "./protocol";

interface TuiOptions {
  port: number;
  auth: OpenCodeAuth;
  /** Test seam: inject a renderer factory (see @opentui/core/testing). */
  createRenderer?: typeof createCliRenderer;
}

type ViewId = "models" | "account" | "runtime";

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
  { id: "runtime", label: "Runtime" },
];

const MODES: Array<OpenCodeMode> = ["console", "go"];

const HINTS: Record<ViewId, string> = {
  models: "j/k move · g/G ends · Enter default · r refresh · / filter · 1-3/arrows/tab views · ? · q",
  account: "j/k slot · Enter orgs · l/x sign · z key · c clear · u quota · 1-3/arrows/tab views · ? · q",
  runtime: "s server · e overrides · d desktop · r log · 1-3/arrows/tab views · ? · q",
};

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

export async function runTui(options: TuiOptions): Promise<() => void> {
  removeStaleDaemonFile();
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

  // Header: brand + per-slot account summary.
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
  for (const view of VIEWS) {
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
    visibleModels = filterModels(models, filterInput.value);
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

  // --- account view: one slot per mode (console / go) ---

  const accountView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  const slotSelect = new SelectRenderable(renderer, { flexGrow: 1, width: "100%", showDescription: true, showScrollIndicator: true });
  const orgSelect = new SelectRenderable(renderer, { flexGrow: 1, width: "100%", showDescription: true, showScrollIndicator: true });
  const slotsInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const quotaLabel = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  const editLabel = new TextRenderable(renderer, { content: "", fg: THEME_WARN });
  const keyInput = new InputRenderable(renderer, {
    placeholder: "press z on a slot to paste its service key…",
    maxLength: 200,
    width: "100%",
  });
  const loginPanel = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: THEME_BG, width: "100%", paddingLeft: 1 });
  loginPanel.visible = false;
  const loginLines = [
    new TextRenderable(renderer, { content: "", fg: THEME_WARN }),
    new TextRenderable(renderer, { content: "", fg: THEME_TEXT }),
    new TextRenderable(renderer, { content: "", fg: THEME_MUTED }),
  ];
  for (const line of loginLines) loginPanel.add(line);
  orgSelect.visible = false;
  keyInput.visible = false;
  accountView.add(slotSelect);
  accountView.add(orgSelect);
  accountView.add(loginPanel);
  accountView.add(slotsInfo);
  accountView.add(quotaLabel);
  accountView.add(editLabel);
  accountView.add(keyInput);
  content.add(accountView);

  /** Which account view layer is active: the slot list or an org list. */
  let accountLayer: "slots" | "orgs" = "slots";
  let highlightedSlot: OpenCodeMode = "console";
  let orgs: Array<{ id: string; name: string }> = [];
  let loginActive = false;
  let loginAbort: AbortController | undefined;
  let keyEdit: OpenCodeMode | undefined;

  function slotSummary(mode: OpenCodeMode): { name: string; description: string } {
    const session = auth.getSession(mode);
    const keys = loadKeys();
    const envKey = process.env.OPENCODE_API_KEY;
    const fromEnv = !keys.console && !keys.go && envKey ? " (env)" : "";
    if (!session) {
      return {
        name: keys[mode] || (envKey ? "env" : undefined)
          ? `${modeLabel(mode)}: service key ${maskKey(keys[mode] ?? envKey)}${fromEnv}`
          : `${modeLabel(mode)}: not signed in`,
        description: "l: device sign-in · z: paste service key",
      };
    }
    return {
      name: `${modeLabel(mode)}: ${session.email} · ${session.orgName ?? session.orgId ?? "no org"}`,
      description: `device session · ${session.orgs.length === 1 ? "1 org" : `${session.orgs.length} orgs`} · Enter: orgs · x: sign out`,
    };
  }

  function activeSlot(): OpenCodeMode {
    return MODES[slotSelect.getSelectedIndex() ?? 0] ?? "console";
  }

  function renderAccount(): void {
    const keys = loadKeys();
    const envKey = process.env.OPENCODE_API_KEY;
    const fromEnv = !keys.console && !keys.go && envKey ? " (env)" : "";
    slotsInfo.content = `service keys — console: ${maskKey(gatewayKeyFor("opencode", keys))}${fromEnv} · go: ${maskKey(gatewayKeyFor("opencode-go", keys))}${fromEnv} · stored in OC3_HOME (0600)`;
    quotaLabel.content = auth.getSession("go") || keys.go || envKey
      ? "Go quota — u refreshes (go slot):"
      : "Go quota — no go credential yet (z/l on the go slot).";
    if (accountLayer === "orgs") {
      const session = auth.getSession(highlightedSlot);
      orgs = session?.orgs ?? [];
      orgSelect.options = orgs.map((org) => ({
        name: `${org.id === session?.orgId ? "● " : "  "}${org.name}`,
        description: org.id,
        value: org.id,
      }));
      slotSelect.visible = false;
      orgSelect.visible = true;
    } else {
      slotSelect.options = MODES.map((mode) => slotSummary(mode));
      slotSelect.visible = true;
      orgSelect.visible = false;
    }
    editLabel.content = keyEdit ? `→ pasting ${modeLabel(keyEdit)} service key (Enter saves, Esc cancels)…` : "";
    keyInput.visible = keyEdit !== undefined;
    refreshStatus();
  }

  slotSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    highlightedSlot = MODES[index] ?? "console";
    openOrgs();
  });

  orgSelect.on(SelectRenderableEvents.ITEM_SELECTED, async (index: number) => {
    const org = orgs[index];
    if (!org) return;
    try {
      await auth.selectOrganization(org.id, highlightedSlot);
      statusLine = `${modeLabel(highlightedSlot)} active org: ${org.name} (${org.id})`;
      await loadModels(false);
    } catch (error) {
      statusLine = `Org switch failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    closeOrgs();
  });

  function openOrgs(): void {
    const session = auth.getSession(highlightedSlot);
    if (!session) {
      statusLine = `${modeLabel(highlightedSlot)} is not signed in — press l on that slot first.`;
      renderAccount();
      return;
    }
    orgs = session.orgs;
    accountLayer = "orgs";
    statusLine = `${modeLabel(highlightedSlot)} organizations — Enter switches, Esc returns.`;
    renderAccount();
  }

  function closeOrgs(): void {
    accountLayer = "slots";
    highlightedSlot = activeSlot();
    renderAccount();
  }

  function startLogin(): void {
    if (loginActive) return;
    const mode = activeSlot();
    loginActive = true;
    loginPanel.visible = true;
    void runLogin(mode).catch(() => { /* tracked in statusLine */ });
  }

  async function runLogin(mode: OpenCodeMode): Promise<void> {
    loginAbort = new AbortController();
    try {
      await deviceSignIn(auth, mode, undefined, {
        signal: loginAbort.signal,
        onDeviceCode: ({ userCode, verificationUrl }) => {
          loginLines[0]!.content = `Sign in to OpenCode ${modeLabel(mode)}: ${verificationUrl}`;
          loginLines[1]!.content = `User code: ${userCode}`;
        },
        onPoll: (seconds) => {
          loginLines[2]!.content = `Waiting for authorization… ${seconds}s`;
        },
      });
      const session = auth.getSession(mode);
      statusLine = session
        ? `Signed in to ${modeLabel(mode)} as ${session.email}${session.orgs.length > 1 ? ` (${session.orgs.length} orgs — Enter to switch).` : "."}`
        : `Signed in to ${modeLabel(mode)}.`;
    } catch (error) {
      statusLine = `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    loginAbort = undefined;
    loginActive = false;
    loginPanel.visible = false;
    await loadModels(false);
    renderAccount();
  }

  function signOutSlot(): void {
    const mode = activeSlot();
    auth.signOut(mode);
    statusLine = `Signed out of ${modeLabel(mode)}.`;
    renderAccount();
  }

  function editServiceKey(): void {
    if (keyEdit !== undefined) return;
    const mode = activeSlot();
    keyEdit = mode;
    keyInput.value = "";
    keyInput.placeholder = `paste ${mode} service key — Enter saves, Esc cancels…`;
    focusLater(keyInput);
    renderAccount();
  }

  keyInput.on(InputRenderableEvents.ENTER, (value: string) => {
    const key = value.trim();
    if (keyEdit && key) {
      saveKeys({ ...loadKeys(), [keyEdit]: key });
      statusLine = `${modeLabel(keyEdit)} key saved (${maskKey(key)}).`;
    }
    keyEdit = undefined;
    keyInput.value = "";
    keyInput.blur();
    renderAccount();
  });

  function cancelKeyEdit(): void {
    keyEdit = undefined;
    keyInput.value = "";
    keyInput.visible = false;
    keyInput.placeholder = "press z on a slot to paste its service key…";
    keyInput.blur();
  }

  function clearServiceKey(): void {
    const mode = activeSlot();
    saveKeys({ ...loadKeys(), [mode]: undefined });
    statusLine = `${modeLabel(mode)} service key cleared.`;
    renderAccount();
  }

  async function loadUsage(): Promise<void> {
    if (activeSlot() !== "go") {
      statusLine = "Go quota applies to the go slot — j to move there, then u.";
      renderAccount();
      return;
    }
    quotaLabel.content = "Go quota: loading…";
    refreshStatus();
    const key = gatewayKeyFor("opencode-go", loadKeys()) || auth.getSession("go")?.accessToken;
    if (!key) {
      quotaLabel.content = "Go quota: no go credential yet (z/l on the go slot).";
      return;
    }
    try {
      const usage = await fetchGatewayUsage(key);
      quotaLabel.content = `Go quota:\n${usageLines(usage).map((line) => `  ${line}`).join("\n")}`;
    } catch (error) {
      quotaLabel.content = `Go quota: lookup failed — ${error instanceof Error ? error.message : String(error)}`;
    }
    refreshStatus();
  }

  // --- runtime view: proxy + overrides + request feed + log tail ---

  const runtimeView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  const proxyInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const overridesInfo = new TextRenderable(renderer, { content: "", fg: THEME_TEXT });
  const requestsTitle = new TextRenderable(renderer, { content: "Recent /responses requests:", fg: THEME_TEXT });
  const requestsText = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  const logsHint = new TextRenderable(renderer, { content: "serve.log tail (r reloads):", fg: THEME_MUTED });
  const logsBox = new ScrollBoxRenderable(renderer, { flexGrow: 1, width: "100%", stickyScroll: true, stickyStart: "bottom", backgroundColor: THEME_BG });
  const logsText = new TextRenderable(renderer, { content: "", fg: THEME_MUTED });
  logsBox.add(logsText);
  runtimeView.add(proxyInfo);
  runtimeView.add(overridesInfo);
  runtimeView.add(requestsTitle);
  runtimeView.add(requestsText);
  runtimeView.add(logsHint);
  runtimeView.add(logsBox);
  content.add(runtimeView);

  function daemonState(): { running: boolean; port?: number; pid?: number } {
    const info = readDaemonInfo();
    return info && daemonRunning(info) ? { running: true, port: info.port, pid: info.pid } : { running: false };
  }

  function overrides() {
    return { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${options.port}/v1` };
  }

  function renderRuntime(): void {
    const daemon = daemonState();
    const proxy = daemon.running
      ? `proxy: daemon on port ${daemon.port} (pid ${daemon.pid})`
      : handle
        ? `proxy: http://127.0.0.1:${handle.port} · requests: ${handle.requestCount()}`
        : "proxy: stopped";
    proxyInfo.content = proxy;
    const applied = overridesApplied(overrides());
    overridesInfo.content = `config: ${applied ? "overridden" : "original"} · backup: ${backupState()}`;
    const records = handle ? [...handle.recentRequests()].reverse().slice(0, 8) : [];
    requestsText.content = records.length ? records.map(formatRequestRecord).join("\n") : handle ? "(no requests yet)" : "(in-process server not running — attach state shown above)";
    loadLogs();
    refreshStatus();
  }

  function backupState(): string {
    try {
      return readBackup() ? "present" : "none";
    } catch {
      return "unreadable";
    }
  }

  async function toggleServer(): Promise<void> {
    const daemon = daemonState();
    if (handle) {
      handle.stop();
      handle = undefined;
      statusLine = "In-process server stopped.";
    } else if (daemon.running) {
      const { stopped, restored } = await stopAll();
      statusLine = `${stopped ? "Daemon stopped." : "Daemon stop failed."}${restored.changed ? " Config restored." : ""}`;
    } else {
      try {
        handle = await startServer({ port: options.port, auth });
        statusLine = `Server started on port ${handle.port}.`;
      } catch (error) {
        statusLine = `Server failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    renderRuntime();
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
    renderRuntime();
  }

  function bootDesktop(): void {
    const launched = launchChatGptDesktop();
    statusLine = launched ? "Booted ChatGPT desktop." : "Could not launch ChatGPT desktop (open -a ChatGPT).";
    refreshStatus();
  }

  function loadLogs(): void {
    const tail = readServeLogTail(120);
    logsText.content = tail || (existsSync(serveLogPath()) ? "(log file is empty)" : "(no serve log yet — s starts the in-process server)");
  }

  // --- view switching ---

  function setView(next: ViewId): void {
    active = next;
    helpOpen = false;
    helpBox.visible = false;
    modelsView.visible = next === "models";
    accountView.visible = next === "account";
    runtimeView.visible = next === "runtime";
    if (next === "account") renderAccount();
    if (next === "runtime") renderRuntime();
    if (next !== "account" && keyEdit) cancelKeyEdit();
    if (next !== "account" && accountLayer === "orgs") { accountLayer = "slots"; }
    if (next !== "models" && filterOpen) closeFilter(true);
    renderTabs();
    if (next !== "runtime") refreshStatus();
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
    const consoleSession = auth.getSession("console");
    const goSession = auth.getSession("go");
    const badge = (session: ConsoleSession | undefined, label: string): string =>
      session ? `${label} ${session.orgName ?? session.orgId ?? "no org"}` : `${label} —`;
    accountBadge.content = [badge(consoleSession, "console:"), badge(goSession, "go:")].join(" · ");
    status.content = statusLine;
    footer.content = active === "account" && accountLayer === "orgs"
      ? "j/k org · Enter switch · Esc slots · 1-3/arrows/tab views · ? · q"
      : HINTS[active];
  }

  function toggleHelp(): void {
    helpOpen = !helpOpen;
    helpBox.visible = helpOpen;
    modelsView.visible = helpOpen ? false : active === "models";
    accountView.visible = helpOpen ? false : active === "account";
    runtimeView.visible = helpOpen ? false : active === "runtime";
    if (!helpOpen) {
      refreshStatus();
      return;
    }
    status.content = "";
    footer.content = "? or Esc close · tab/1-3 view · q quit";
  }

  const helpBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", paddingLeft: 1, gap: 1 });
  helpBox.visible = false;
  content.add(helpBox);
  helpBox.add(new TextRenderable(renderer, { content: "oc3 — keybindings", fg: THEME_ACCENT }));
  for (const line of [
    "1-3, arrows, or tab switch views (Models, Account, Runtime)",
    "j / k               move selection (Shift for fast scroll)",
    "g / G               jump to top / bottom of a list",
    "Enter               activate the highlighted item",
    "Models:  r refresh catalog · / filter models",
    "Account: l device-code sign in (highlighted slot) · x sign out · z paste service key · c clear key · u Go quota",
    "Runtime: s toggle server/daemon · e config overrides · d boot ChatGPT desktop · r reload log tail",
    "?                  toggle this help",
    "q                  quit",
    "Esc                close filter / input / help (no-op elsewhere)",
  ]) {
    helpBox.add(new TextRenderable(renderer, { content: line, fg: THEME_MUTED }));
  }

  // Poll timers: runtime request feed + log tail. They self-clear once the
  // renderer is gone (tests may destroy it directly).
  timers.push(setInterval(() => {
    if (renderer.isDestroyed) { quit(); return; }
    if (active === "runtime" && !helpOpen) renderRuntime();
  }, 1000));

  function quit(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    for (const timer of focusTimers) clearTimeout(timer);
    loginAbort?.abort();
    handle?.stop();
    try { renderer.destroy(); } catch { /* already gone */ }
  }

  renderer.keyInput.on("keypress", (key) => {
    // Text inputs own the keyboard while open; up/down still moves the list.
    if (filterOpen) {
      if (key.name === "escape") closeFilter(true);
      else if (key.name === "down") modelSelect.moveDown(key.shift ? 5 : 1);
      else if (key.name === "up") modelSelect.moveUp(key.shift ? 5 : 1);
      return;
    }
    if (keyEdit) {
      if (key.name === "escape") {
        cancelKeyEdit();
        renderAccount();
      }
      return;
    }
    if (helpOpen) {
      if (key.sequence === "?" || key.name === "escape") toggleHelp();
      return;
    }
    if (key.name === "q") { quit(); return; }
    if (key.name === "escape") {
      // Esc closes modal layers only; q quits.
      if (accountLayer === "orgs") { closeOrgs(); return; }
      return;
    }
    if (key.name === "tab") {
      const index = VIEWS.findIndex((view) => view.id === active);
      setView(VIEWS[(index + 1) % VIEWS.length]!.id);
      return;
    }
    if (key.name === "left" || key.name === "right") {
      const index = VIEWS.findIndex((view) => view.id === active);
      const step = key.name === "right" ? 1 : VIEWS.length - 1;
      setView(VIEWS[(index + step) % VIEWS.length]!.id);
      return;
    }
    if (/^[1-3]$/.test(key.sequence ?? "")) {
      const viewIndex = Number(key.sequence) - 1;
      if (viewIndex < VIEWS.length) setView(VIEWS[viewIndex]!.id);
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
        const list = accountLayer === "orgs" ? orgSelect : slotSelect;
        if (key.name === "down" || key.name === "j") { list.moveDown(); return; }
        if (key.name === "up" || key.name === "k") { list.moveUp(); return; }
        if (key.name === "return" || key.name === "enter") { list.selectCurrent(); return; }
        if (accountLayer === "orgs") { closeOrgs(); return; }
        if (key.name === "l") { startLogin(); return; }
        if (key.name === "x") { signOutSlot(); return; }
        if (key.name === "z") { editServiceKey(); return; }
        if (key.name === "c") { clearServiceKey(); return; }
        if (key.name === "u") { void loadUsage(); return; }
        return;
      }
      case "runtime": {
        if (key.name === "s") { void toggleServer(); return; }
        if (key.name === "e") { void toggleOverrides(); return; }
        if (key.name === "d") { bootDesktop(); return; }
        if (key.name === "r") { loadLogs(); return; }
        return;
      }
    }
  });

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

  /** Stops timers/servers and destroys the renderer; safe to call twice. */
  return () => {
    quit();
  };
}