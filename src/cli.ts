#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { displayName, type Oc3Model } from "./models";
import { writeCodexCatalog } from "./codex-catalog";
import { startServer } from "./server";
import { applyCodexOverrides, codexConfigPath, overridesApplied, restoreCodexOverrides } from "./codex-config";
import { clearDaemonInfo, daemonRunning, launchDetachedServe, launchChatGptDesktop, readDaemonInfo, removeStaleDaemonFile, serveLogPath, stopDaemon, writeDaemonInfo } from "./daemon";
import { codexCatalogPath } from "./store";

import { deviceSignIn } from "./signin";
import { DEFAULT_CONSOLE_SERVER } from "./protocol";
import { clearKeys, ensureHome, loadKeys, saveKeys } from "./store";
import { fetchGatewayUsage, gatewayKeyFor } from "./gateway";
import { runTui } from "./tui";

// Injected at build time by the release workflow (--define OC3_VERSION)
declare const OC3_VERSION: string | undefined;
const version = JSON.parse(typeof OC3_VERSION !== "undefined" ? OC3_VERSION : "\"dev\"") as string;

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = "tui", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function port(flags: Record<string, string | boolean>): number {
  const value = Number(flags.port ?? 8788);
  return Number.isFinite(value) && value > 0 ? value : 8788;
}

async function main(): Promise<void> {
  const auth = new OpenCodeAuth();
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  ensureHome();

  switch (command) {
    case "login": {
      const mode = loginMode(flags);
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
      const mode = flags.mode === "go" || flags.mode === "console" ? flags.mode : undefined;
      if (typeof flags.mode === "string" && !mode) {
        console.error(`Unknown mode: ${flags.mode} (use console or go)`);
        process.exitCode = 1;
        return;
      }
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
        const mode = flags.mode === "go" || flags.mode === "console" ? flags.mode : "console";
        if (typeof flags.mode === "string" && flags.mode !== mode) {
          console.error(`Unknown key mode: ${flags.mode} (use console or go)`);
          process.exitCode = 1;
          return;
        }
        saveKeys({ ...loadKeys(), [mode]: setFlag });
        console.log(`OpenCode ${mode} service key saved to OC3_HOME/keys.json (0600).`);
        return;
      }
      const keys = loadKeys();
      const env = process.env.OPENCODE_API_KEY ? "OPENCODE_API_KEY" : undefined;
      const consoleKey = keys.console ?? env;
      const goKey = keys.go ?? env;
      const show = (value: string | undefined) => value ? `set (${value.slice(0, 4)}…${value.slice(-4)})` : "not set";
      console.log(`console: ${show(consoleKey)}`);
      console.log(`go:      ${show(goKey)}`);
      if (!consoleKey) console.log("Configure with: oc3 keys --set <console-service-key>  (from https://opencode.ai/auth)");
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
      const mode = flags.mode === "go" ? "go" : "console";
      if (typeof flags.mode === "string" && flags.mode !== "console" && flags.mode !== "go") {
        console.error(`Unknown mode: ${flags.mode} (use console or go)`);
        process.exitCode = 1;
        return;
      }
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
        console.log("No models cached. Run: oc3 models --refresh (Console sign-in optional; Zen/Go catalogs are public)");
        process.exitCode = 1;
        return;
      }
      await writeCodexCatalog(models);
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
      await writeCodexCatalog(models);
      const overrides = { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${p}/v1` };
      const result = applyCodexOverrides(overrides);
      console.log(`Config overrides ${result.changed ? `applied to ${codexConfigPath()}` : "already in place"} (backup: ${result.backupCreated ? "created" : "kept"})`);
      const cliEntry = Bun.argv[1]?.startsWith("/$bunfs/") ? undefined : (Bun.argv[1] ?? "src/cli.ts");
      const childPid = launchDetachedServe(cliEntry, p);
      const ready = await waitForHealth(p, 10_000);
      if (!ready) {
        console.error("oc3 proxy did not become healthy in time. Check `oc3 logs`.");
        process.exitCode = 1;
        return;
      }
      writeDaemonInfo({ pid: childPid, port: p });
      console.log(`oc3 proxy running on http://127.0.0.1:${p} (pid ${childPid}, detached)`);
      if (flags["no-launch"] !== true) {
        const launched = launchChatGptDesktop();
        console.log(launched ? "Booted ChatGPT desktop." : "Could not launch ChatGPT desktop (open -a ChatGPT).");
      }
      console.log("Logs: `oc3 logs`  Status: `oc3 status`  Restore: `oc3 stop`");
      return;
    }
    case "logs": {
      const lines = Number(flags.lines ?? 30);
      const path = serveLogPath();
      if (!existsSync(path)) { console.log("No serve log yet. Start with: oc3 start"); return; }
      const content = readFileSync(path, "utf8").split("\n");
      console.log(content.slice(Math.max(0, content.length - Math.max(1, lines))).join("\n"));
      return;
    }
    case "stop": {
      removeStaleDaemonFile();
      const stopped = stopDaemon();
      const restored = restoreCodexOverrides();
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
      await runTui({ port: port(flags), auth });
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

async function promptOrgChoice(count: number): Promise<number | undefined> {
  process.stdout.write("Org number [1]: ");
  const answer = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    process.stdin.once("data", onData);
    process.stdin.once("end", () => {
      process.stdin.removeListener("data", onData);
      resolve("");
    });
    setTimeout(() => {
      process.stdin.removeListener("data", onData);
      resolve("");
    }, 30_000);
  });
  const value = answer.trim();
  if (!value) return 0;
  const index = Number.parseInt(value, 10) - 1;
  return index >= 0 && index < count ? index : undefined;
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch { /* not ready yet */ }
    await Bun.sleep(200);
  }
  return false;
}

function loginMode(flags: Record<string, string | boolean>): "console" | "go" {
  if (typeof flags.mode === "string" && flags.mode !== "console" && flags.mode !== "go") {
    throw new Error(`Unknown mode: ${flags.mode} (use console or go)`);
  }
  return flags.mode === "go" ? "go" : "console";
}

const USAGE = `oc3 — OpenCode Console proxy for Codex / ChatGPT desktop

Usage:
  oc3                     Open the TUI dashboard
                          (1 Models · 2 Account · 3 Gateway · 4 Proxy · 5 Logs)
  oc3 login [--mode console|go] [--org ID]
                          Device-code sign in to OpenCode Console (slot: console, or go)
  oc3 whoami              Show signed-in accounts for every mode slot
  oc3 org [--mode M] [--org ID]
                          List or select the active organization for a slot
  oc3 models [--refresh]  List models and regenerate the Codex catalog
  oc3 keys [--set KEY]    Store a service key for console (default) or go: --set KEY --mode go
                          (--clear wipes both; TUI Gateway view for interactive use)
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
  OPENCODE_API_KEY      OpenCode service key fallback (alternative to oc3 keys)
`;

await main();
