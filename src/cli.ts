#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { displayName, type Oc3Model } from "./models";
import { writeCodexCatalog } from "./codex-catalog";
import { startServer } from "./server";
import { codexConfigPath, overridesApplied } from "./codex-config";
import { clearDaemonInfo, daemonRunning, launchChatGptDesktop, readDaemonInfo, readServeLogTail, removeStaleDaemonFile, rotateServeLog, serveLogPath, writeDaemonInfo } from "./daemon";
import { startAll, stopAll } from "./lifecycle";
import { codexCatalogPath } from "./store";
import { parseArgs, parseIntFlag, parseModeFlag, parseOrgChoice, type Flags } from "./cli-args";
import { maskKey } from "./secrets";
import type { OpenCodeMode } from "./protocol";

import { deviceSignIn } from "./signin";
import { DEFAULT_CONSOLE_SERVER } from "./protocol";
import { clearKeys, ensureHome, loadKeys, saveKeys } from "./store";
import { fetchGatewayUsage, gatewayKeyFor } from "./gateway";
import { runTui } from "./tui";

// Injected at build time by the release workflow (--define OC3_VERSION)
declare const OC3_VERSION: string | undefined;
const version = JSON.parse(typeof OC3_VERSION !== "undefined" ? OC3_VERSION : "\"dev\"") as string;

function port(flags: Flags): number {
  return parseIntFlag(flags, "port", 8788, { min: 1, max: 65535 });
}

async function main(): Promise<void> {
  const auth = new OpenCodeAuth();
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  ensureHome();

  switch (command) {
    case "login": {
      const mode = parseModeFlag(flags, "console") ?? "console";
      const server = typeof flags.server === "string" ? flags.server : DEFAULT_CONSOLE_SERVER;
      const session = await deviceSignIn(auth, mode, server, {
        onDeviceCode: ({ userCode, verificationUrl }) => {
          console.log(`Sign in to OpenCode ${mode}: ${verificationUrl}`);
          console.log(`User code: ${userCode}`);
        },
        onPoll: (seconds) => {
          process.stdout.write(`\rWaiting for authorization... ${seconds}s   `);
        },
      });
      process.stdout.write("\n");
      if (typeof flags.org === "string" && flags.org) {
        await auth.selectOrganization(flags.org, mode);
      } else if (session.orgs.length > 1 && process.stdin.isTTY) {
        console.log(`Signed in as ${session.email}. Pick an organization:`);
        session.orgs.forEach((org, index) => console.log(`  ${index + 1}. ${org.name} (${org.id})`));
        const selected = await promptOrgChoice(session.orgs.length);
        if (selected !== undefined) await auth.selectOrganization(session.orgs[selected]!.id, mode);
      }
      const final = auth.getSession(mode);
      if (!final) throw new Error(`OpenCode ${mode} session missing after sign-in`);
      console.log(`Signed in as ${final.email} (org: ${final.orgName ?? final.orgId ?? "none"}).`);
      if (final.orgs.length > 1 && !process.stdin.isTTY && !flags.org) {
        console.log(`Multiple orgs available; switch with: oc3 org --mode ${mode} --org <id>`);
      }
      return;
    }
    case "logout": {
      const mode = parseModeFlag(flags);
      if (mode) auth.signOut(mode);
      else { auth.signOut("console"); auth.signOut("go"); }
      console.log("Signed out.");
      return;
    }
    case "keys": {
      if (flags.clear) {
        clearKeys();
        console.log("Stored OpenCode service keys cleared.");
        return;
      }
      const setFlag = typeof flags.set === "string" ? flags.set : undefined;
      if (setFlag) {
        const mode = parseModeFlag(flags) ?? "console";
        saveKeys({ ...loadKeys(), [mode]: setFlag });
        console.log(`OpenCode ${mode} service key saved to OC3_HOME/keys.json (0600).`);
        return;
      }
      const keys = loadKeys();
      const envKey = process.env.OPENCODE_API_KEY || undefined;
      console.log(`console: ${describeKey(keys.console, envKey)}`);
      console.log(`go:      ${describeKey(keys.go, envKey)}`);
      if (!keys.console && !envKey) console.log("Configure with: oc3 keys --set <console-service-key>  (from https://opencode.ai/auth)");
      return;
    }
    case "usage": {
      const keys = loadKeys();
      const key = gatewayKeyFor("opencode-go", keys);
      if (!key) {
        console.log("No OpenCode Go key configured. Run: oc3 keys --set <go-service-key> --mode go (or set OPENCODE_API_KEY)");
        process.exitCode = 1;
        return;
      }
      try {
        const usage = await fetchGatewayUsage(key);
        console.log(JSON.stringify(usage, null, 2));
      } catch (error) {
        console.error(`Usage lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }
    case "whoami": {
      const consoleSlot = auth.getSession("console");
      const goSlot = auth.getSession("go");
      if (!consoleSlot && !goSlot) { console.log("Not signed in."); process.exitCode = 1; return; }
      const show = (mode: "console" | "go", session: typeof consoleSlot): void => {
        if (!session) { console.log(`${mode}: not signed in`); return; }
        console.log(`${mode}: ${session.email}  server=${session.server}  org=${session.orgName ?? session.orgId ?? "none"}`);
      };
      show("console", consoleSlot);
      show("go", goSlot);
      consoleSlot?.orgs.forEach((org) => console.log(`  org: ${org.id} ${org.name}${org.id === consoleSlot?.orgId ? " (active)" : ""}`));
      goSlot?.orgs.forEach((org) => console.log(`  go org: ${org.id} ${org.name}${org.id === goSlot?.orgId ? " (active)" : ""}`));
      return;
    }
    case "org": {
      const mode: OpenCodeMode = parseModeFlag(flags) ?? "console";
      const session = auth.getSession(mode);
      if (!session) { console.log(`Not signed in to OpenCode ${mode}. Run: oc3 login --mode ${mode}`); process.exitCode = 1; return; }
      if (typeof flags.org === "string" && flags.org) {
        const next = await auth.selectOrganization(flags.org, mode);
        console.log(`Active org: ${next.orgName} (${next.orgId})`);
        return;
      }
      session.orgs.forEach((org) => console.log(`${org.id}${org.id === session.orgId ? " * (active)" : ""}  ${org.name}`));
      return;
    }
    case "models": {
      const refreshed = flags.refresh ? await refreshModels(auth) : undefined;
      const models = refreshed ? refreshed.models : availableModels();
      for (const error of refreshed?.errors ?? []) console.error(`Warning: ${error}`);
      if (!models.length) {
        if (refreshed?.errors.length) console.error(refreshed.errors[0]);
        console.log("No models cached. Run: oc3 models --refresh (Console sign-in optional; the public OpenCode catalogs are used otherwise)");
        process.exitCode = 1;
        return;
      }
      writeCodexCatalog(models);
      console.log(`Found ${models.length} models. Codex catalog written.`);
      for (const model of models) {
        const cost = costLabel(model.cost);
        console.log(`  ${model.id.padEnd(44)} ${backendTag(model).padEnd(9)} ${model.endpoint.padEnd(16)} ctx=${model.contextLength}${cost}`);
      }
      return;
    }
    case "serve": {
      const handle = await startServer({ port: port(flags), auth });
      writeDaemonInfo({ pid: process.pid, port: handle.port });
      console.log(`oc3 proxy listening on http://127.0.0.1:${handle.port}`);
      console.log(`Codex profile base_url: http://127.0.0.1:${handle.port}/v1`);
      process.on("SIGINT", () => { handle.stop(); clearDaemonInfo(); process.exit(0); });
      process.on("SIGTERM", () => { handle.stop(); clearDaemonInfo(); process.exit(0); });
      return;
    }
    case "start": {
      const p = port(flags);
      removeStaleDaemonFile();
      const existing = readDaemonInfo();
      if (existing && daemonRunning(existing)) {
        console.log(`oc3 proxy already running on port ${existing.port} (pid ${existing.pid}).`);
        return;
      }
      let models = availableModels();
      if (!models.length) {
        console.log("No cached models; refreshing catalogs...");
        const refreshed = await refreshModels(auth);
        models = refreshed.models;
        for (const error of refreshed.errors) console.error(`Warning: ${error}`);
      }
      if (!models.length) console.error("Warning: no models are available; Codex will list none until `oc3 models --refresh` succeeds.");
      writeCodexCatalog(models);
      rotateServeLog();
      await startProxy(p, flags);
      return;
    }
    case "logs": {
      const lines = parseIntFlag(flags, "lines", 30, { min: 1, max: 10_000 });
      if (!existsSync(serveLogPath())) { console.log("No serve log yet. Start with: oc3 start"); return; }
      console.log(readServeLogTail(lines));
      return;
    }
    case "stop": {
      const { stopped, restored } = await stopAll();
      if (stopped) console.log("oc3 proxy stopped.");
      if (restored.changed) console.log(`Config restored from backup (${codexConfigPath()}).`);
      else if (!restored.hadBackup) console.log("No oc3 overrides found to restore.");
      if (process.platform === "darwin") console.log("Restart ChatGPT desktop if it still points at the old endpoint.");
      return;
    }
    case "status": {
      const info = readDaemonInfo();
      removeStaleDaemonFile();
      const live = info && daemonRunning(info);
      const effectivePort = live ? info!.port : port(flags);
      const applied = overridesApplied({ model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${effectivePort}/v1` });
      console.log(`proxy: ${live ? `running on port ${info!.port} (pid ${info!.pid})` : "stopped"}`);
      console.log(`config overrides: ${applied ? "applied" : "not applied"} (${codexConfigPath()})`);
      return;
    }
    case "tui": {
      const cleanup = await runTui({ port: port(flags), auth });
      process.once("exit", cleanup);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      console.log(`oc3 ${version}\n\n${USAGE}`);
      return;
    }
    case "version":
    case "--version": {
      console.log(`oc3 ${version}`);
      return;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
    }
  }
}

/** Starts the detached proxy and reports the outcome; rollback lives in startAll. */
async function startProxy(p: number, flags: Flags): Promise<void> {
  const cliEntry = Bun.argv[1]?.startsWith("/$bunfs/") ? undefined : (Bun.argv[1] ?? "src/cli.ts");
  const outcome = await startAll({
    port: p,
    cliEntry,
    overrides: { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${p}/v1` },
  });
  if (!outcome.ok) {
    console.error(outcome.reason === "unhealthy"
      ? "oc3 proxy did not become healthy in time. Check `oc3 logs`."
      : `oc3 could not start the proxy: ${outcome.error ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Config overrides ${outcome.applied.changed ? `applied to ${codexConfigPath()}` : "already in place"} (backup: ${outcome.applied.backupCreated ? "created" : "kept"})`);
  console.log(`oc3 proxy running on http://127.0.0.1:${p} (pid ${outcome.pid}, detached)`);
  if (flags["no-launch"] !== true) {
    const launched = launchChatGptDesktop();
    console.log(launched ? "Booted ChatGPT desktop." : "Could not launch ChatGPT desktop (open -a ChatGPT).");
  }
  console.log("Logs: `oc3 logs`  Status: `oc3 status`  Restore: `oc3 stop`");
}

function describeKey(stored: string | undefined, envKey: string | undefined): string {
  if (stored) return `set (${maskKey(stored)})`;
  if (envKey) return `set from OPENCODE_API_KEY (${maskKey(envKey)})`;
  return "not set";
}

function backendTag(model: Oc3Model): string {
  const match = /\[([^\]]+)\]$/.exec(displayName(model));
  return match ? `[${match[1]}]` : "";
}

function costLabel(cost: Oc3Model["cost"]): string {
  if (!cost || (cost.input === undefined && cost.output === undefined)) return "";
  const input = cost.input !== undefined ? `$${trimNumber(cost.input)}` : "?";
  const output = cost.output !== undefined ? `$${trimNumber(cost.output)}` : "?";
  return `  ${input}/${output} per Mtok`;
}

function trimNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** Reads one line from the org picker; no answer within 30 s picks the first org. */
async function promptOrgChoice(count: number): Promise<number | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), 30_000);
  });
  try {
    const answer = await Promise.race([rl.question("Org number [1]: "), timeout]);
    return parseOrgChoice(answer, count);
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

const USAGE = `oc3 — OpenCode Console proxy for Codex / ChatGPT desktop

Usage:
  oc3                     Open the TUI dashboard
                          (1 Models · 2 Account · 3 Runtime)
  oc3 login [--mode console|go] [--org ID]
                          Device-code sign in to OpenCode Console (slot: console, or go)
  oc3 whoami              Show signed-in accounts for every mode slot
  oc3 org [--mode M] [--org ID]
                          List or select the active organization for a slot
  oc3 models [--refresh]  List models and regenerate the Codex catalog
  oc3 keys [--set KEY]    Store a service key for console (default) or go: --set KEY --mode go
                          (--clear wipes both; TUI Account view for interactive use)
  oc3 usage               Show OpenCode Go subscription quota
  oc3 start [--port N]    Apply overrides, start detached proxy, boot ChatGPT desktop
                          (--no-launch skips booting ChatGPT desktop)
  oc3 stop                Restore previous config values and stop the proxy
  oc3 status              Show proxy and override state
  oc3 logs [--lines N]    Show recent proxy log lines (default 30)
  oc3 serve [--port N]    Run the proxy server without touching config.toml
  oc3 logout [--mode M]   Remove stored device sessions (every slot by default)

Environment:
  OC3_HOME            State directory (default ~/.config/oc3)
  OPENAI_API_KEY      Enables bridging native OpenAI models (openai/<model> slugs)
  OC3_OPENAI_MODELS   Comma-separated OpenAI model ids to expose
  OPENCODE_API_KEY    OpenCode service key fallback (alternative to oc3 keys)
`;

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
