#!/usr/bin/env bun
import { OpenCodeAuth } from "./auth";
import { availableModels, refreshModels } from "./console";
import { writeCodexCatalog } from "./codex-catalog";
import { startServer } from "./server";
import { applyCodexOverrides, codexConfigPath, overridesApplied, restoreCodexOverrides } from "./codex-config";
import { clearDaemonInfo, daemonRunning, launchChatGptDesktop, readDaemonInfo, removeStaleDaemonFile, stopDaemon, writeDaemonInfo } from "./daemon";
import { codexCatalogPath } from "./store";
import { DEFAULT_CONSOLE_SERVER } from "./protocol";
import { ensureHome, loadSession, loadState, saveState } from "./store";
import { runTui } from "./tui";

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
      const server = typeof flags.server === "string" ? flags.server : DEFAULT_CONSOLE_SERVER;
      const device = await auth.requestDeviceCode(server);
      console.log(`Sign in: ${device.verificationUrl}`);
      console.log(`User code: ${device.userCode}`);
      try {
        const proc = Bun.spawn(["open", device.verificationUrl], { stdout: "ignore", stderr: "ignore" });
        void proc.exited;
      } catch { /* open only on macOS; the URL is printed above */ }
      const session = await auth.completeDeviceSignIn(device, undefined, (seconds) => {
        process.stdout.write(`\rWaiting for authorization... ${seconds}s   `);
      });
      process.stdout.write("\n");
      if (typeof flags.org === "string" && flags.org) {
        await auth.selectOrganization(flags.org);
      } else if (session.orgs.length > 1 && process.stdin.isTTY) {
        console.log(`Signed in as ${session.email}. Pick an organization:`);
        session.orgs.forEach((org, index) => console.log(`  ${index + 1}. ${org.name} (${org.id})`));
        const selected = await promptOrgChoice(session.orgs.length);
        if (selected !== undefined) await auth.selectOrganization(session.orgs[selected]!.id);
      }
      const final = loadSessionSafe() ?? session;
      console.log(`Signed in as ${final.email} (org: ${final.orgName ?? final.orgId ?? "none"})`);
      if (final.orgs.length > 1 && !process.stdin.isTTY && !flags.org) {
        console.log(`Multiple orgs available; switch with: oc3 org --org <id>`);
      }
      return;
    }
    case "logout": {
      auth.signOut();
      console.log("Signed out.");
      return;
    }
    case "whoami": {
      const session = auth.getSession();
      if (!session) { console.log("Not signed in."); process.exitCode = 1; return; }
      console.log(`${session.email}  server=${session.server}  org=${session.orgName ?? session.orgId ?? "none"}`);
      session.orgs.forEach((org) => console.log(`  org: ${org.id} ${org.name}${org.id === session.orgId ? " (active)" : ""}`));
      return;
    }
    case "org": {
      const session = auth.getSession();
      if (!session) { console.log("Not signed in. Run: oc3 login"); process.exitCode = 1; return; }
      if (typeof flags.org === "string" && flags.org) {
        const next = await auth.selectOrganization(flags.org);
        console.log(`Active org: ${next.orgName} (${next.orgId})`);
        return;
      }
      session.orgs.forEach((org) => console.log(`${org.id}${org.id === session.orgId ? " * (active)" : ""}  ${org.name}`));
      return;
    }
    case "models": {
      const models = flags.refresh ? await refreshModels(auth) : availableModels();
      if (!models.length) {
        console.log("No models cached. Run: oc3 models --refresh (requires sign-in)");
        process.exitCode = 1;
        return;
      }
      await writeCodexCatalog(models);
      console.log(`Found ${models.length} models. Codex catalog written.`);
      for (const model of models) {
        console.log(`  ${model.id.padEnd(48)} ${model.endpoint.padEnd(16)} ctx=${model.contextLength}`);
      }
      return;
    }
    case "serve": {
      const handle = await startServer({ port: port(flags), auth });
      console.log(`oc3 proxy listening on http://127.0.0.1:${handle.port}`);
      console.log(`Codex profile base_url: http://127.0.0.1:${handle.port}/v1`);
      process.on("SIGINT", () => { handle.stop(); process.exit(0); });
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
        console.log("No cached models; refreshing from Console...");
        models = await refreshModels(auth);
      }
      await writeCodexCatalog(models);
      const overrides = { model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${p}/v1` };
      const result = applyCodexOverrides(overrides);
      console.log(`Config overrides ${result.changed ? `applied to ${codexConfigPath()}` : "already in place"} (backup: ${result.backupCreated ? "created" : "kept"})`);
      const handle = await startServer({ port: p, auth });
      writeDaemonInfo({ pid: process.pid, port: handle.port });
      console.log(`oc3 proxy listening on http://127.0.0.1:${handle.port}`);
      if (flags["no-launch"] !== true) {
        const launched = launchChatGptDesktop();
        console.log(launched ? "Booted ChatGPT desktop." : "Could not launch ChatGPT desktop (open -a ChatGPT).");
      }
      console.log("Run `oc3 stop` to restore the previous endpoint and models.");
      process.on("SIGINT", () => { handle.stop(); console.log("\nProxy stopped. Overrides remain applied; run `oc3 stop` to restore."); process.exit(0); });
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
      const applied = overridesApplied({ model_catalog_json: codexCatalogPath(), openai_base_url: `http://127.0.0.1:${port(flags)}/v1` });
      console.log(`proxy: ${live ? `running on port ${info!.port} (pid ${info!.pid})` : "stopped"}`);
      console.log(`config overrides: ${applied ? "applied" : "not applied"} (${codexConfigPath()})`);
      return;
    }
    case "snippet": {
      const state = loadState<{ defaultModel?: string }>({});
      const selected = typeof flags.model === "string" && flags.model ? flags.model : state.defaultModel ?? "<model-id>";
      const p = port(flags);
      console.log(`# Add to ~/.codex/config.toml manually (oc3 never writes it for you):`);
      console.log(`[profiles.oc3]`);
      console.log(`model = "${selected}"`);
      console.log(`model_provider = "oc3"`);
      console.log("");
      console.log(`[model_providers.oc3]`);
      console.log(`name = "OpenCode Console (oc3)"`);
      console.log(`base_url = "http://127.0.0.1:${p}/v1"`);
      console.log(`wire_api = "responses"`);
      console.log("");
      console.log(`# Then run: codex --profile oc3`);
      return;
    }
    case "catalog": {
      const models = availableModels();
      if (!models.length) { console.log("No cached models. Run: oc3 models --refresh"); process.exitCode = 1; return; }
      await writeCodexCatalog(models);
      console.log("Codex catalog regenerated.");
      return;
    }
    case "tui": {
      await runTui({ port: port(flags), auth });
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      console.log(USAGE);
      return;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
    }
  }
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

function loadSessionSafe() {
  const auth = new OpenCodeAuth();
  return auth.getSession();
}

const USAGE = `oc3 — OpenCode Console proxy for Codex / ChatGPT desktop

Usage:
  oc3                     Open the TUI dashboard (proxy + model picker)
  oc3 login [--org ID]    Device-code sign in to OpenCode Console
  oc3 whoami              Show signed-in account and organizations
  oc3 org [--org ID]      List or select the active organization
  oc3 models [--refresh]  List models and regenerate the Codex catalog
  oc3 start [--port N]    Apply config overrides, start the proxy, boot ChatGPT desktop
                          (--no-launch skips booting ChatGPT desktop)
  oc3 stop                Restore previous config values and stop the proxy
  oc3 status              Show proxy and override state
  oc3 serve [--port N]    Run the proxy server without touching config.toml
  oc3 catalog             Regenerate codex-models.json from cached models
  oc3 logout              Remove stored Console credentials

Environment:
  OC3_HOME            State directory (default ~/.config/oc3)
  OPENAI_API_KEY      Enables bridging native OpenAI models (openai/<model> slugs)
  OC3_OPENAI_MODELS   Comma-separated OpenAI model ids to expose
`;

await main();
