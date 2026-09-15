import { existsSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { oc3Home, ensureHome } from "./store";

export interface DaemonInfo {
  pid: number;
  port: number;
}

function daemonPath(): string {
  return join(oc3Home(), "daemon.json");
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureHome();
  writeFileSync(daemonPath(), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

export function readDaemonInfo(): DaemonInfo | undefined {
  const path = daemonPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonInfo>;
    if (typeof value.pid !== "number" || typeof value.port !== "number") return undefined;
    return value as DaemonInfo;
  } catch {
    return undefined;
  }
}

export function clearDaemonInfo(): void {
  const path = daemonPath();
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

export function daemonRunning(info: DaemonInfo): boolean {
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopDaemon(): boolean {
  const info = readDaemonInfo();
  if (!info) return false;
  if (daemonRunning(info)) {
    try { process.kill(info.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  clearDaemonInfo();
  return true;
}

export function removeStaleDaemonFile(): void {
  const info = readDaemonInfo();
  if (info && !daemonRunning(info)) clearDaemonInfo();
}

export function serveLogPath(): string {
  return join(oc3Home(), "serve.log");
}

export function launchDetachedServe(cliEntry: string, port: number): number {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const logFd = openSync(serveLogPath(), "a");
  const child = spawn(process.execPath, [cliEntry, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid ?? 0;
}

export function launchChatGptDesktop(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const proc = Bun.spawn(["open", "-a", "ChatGPT"], { stdout: "ignore", stderr: "ignore" });
    void proc.exited;
    return true;
  } catch {
    return false;
  }
}
