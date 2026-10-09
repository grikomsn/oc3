import { existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync, readSync, closeSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { oc3Home, ensureHome } from "./store";

export interface DaemonInfo {
  pid: number;
  port: number;
}

const MAX_SERVE_LOG_BYTES = 5 * 1024 * 1024;
const TAIL_READ_BYTES = 64 * 1024;

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
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (!Number.isInteger(value.port) || (value.port as number) <= 0 || (value.port as number) > 65535) return undefined;
    return { pid: value.pid as number, port: value.port as number };
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

/** True when the pid's command line is an oc3 serve process. A reused pid is not ours. */
export function isOc3ServeProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /\bserve\b/.test(command);
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!daemonRunning({ pid, port: 0 })) return true;
    await Bun.sleep(100);
  }
  return !daemonRunning({ pid, port: 0 });
}

export async function stopDaemon(): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info) return false;
  if (daemonRunning(info) && isOc3ServeProcess(info.pid)) {
    try { process.kill(info.pid, "SIGTERM"); } catch { /* already gone */ }
    await waitForExit(info.pid, 3_000);
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

/** Moves an oversized serve.log aside so the log cannot grow without bound. */
export function rotateServeLog(): void {
  const path = serveLogPath();
  if (existsSync(path) && statSync(path).size > MAX_SERVE_LOG_BYTES) renameSync(path, `${path}.1`);
}

/** The last `lines` lines of serve.log, reading at most the final 64 KiB. */
export function readServeLogTail(lines: number): string {
  const path = serveLogPath();
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_READ_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const content = buffer.toString("utf8").split("\n");
  if (start > 0) content.shift();
  return content.slice(Math.max(0, content.length - Math.max(1, lines))).join("\n");
}

/**
 * Detached serve child. Dev runs spawn the bundled cli entry; compiled dist
 * binaries re-exec themselves (their embedded entry boots unconditionally,
 * and passing the bunfs entry path would land as the child's command).
 */
export function launchDetachedServe(cliEntry: string | undefined, port: number): number {
  const logFd = openSync(serveLogPath(), "a");
  const child = cliEntry
    ? spawn(process.execPath, [cliEntry, "serve", "--port", String(port)], { detached: true, stdio: ["ignore", logFd, logFd] })
    : spawn(process.execPath, ["serve", "--port", String(port)], { detached: true, stdio: ["ignore", logFd, logFd] });
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
