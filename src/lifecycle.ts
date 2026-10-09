// Starting and stopping the detached proxy together with its Codex config
// overrides. The two always move as one unit: a start that fails or is
// interrupted restores the overrides, and a stop restores them after the
// proxy is gone.

import { applyCodexOverrides, restoreCodexOverrides, type CodexOverrides } from "./codex-config";
import { daemonRunning, launchDetachedServe, removeStaleDaemonFile, stopDaemon, writeDaemonInfo } from "./daemon";

export interface StopOutcome {
  stopped: boolean;
  restored: { changed: boolean; hadBackup: boolean };
}

export async function stopAll(): Promise<StopOutcome> {
  removeStaleDaemonFile();
  const stopped = await stopDaemon();
  const restored = restoreCodexOverrides();
  return { stopped, restored };
}

export interface StartOptions {
  port: number;
  cliEntry: string | undefined;
  overrides: CodexOverrides;
  healthTimeoutMs?: number;
}

export type StartOutcome =
  | { ok: true; pid: number; applied: { changed: boolean; backupCreated: boolean } }
  | { ok: false; reason: "unhealthy" | "failed"; error?: string };

/**
 * Applies the overrides, starts the detached proxy, and waits until the port
 * answers as that child. Failure, or a Ctrl-C or SIGTERM before success, stops
 * the child and restores the overrides.
 */
export async function startAll(options: StartOptions): Promise<StartOutcome> {
  let childPid = 0;
  let started = false;
  const rollback = (): void => {
    if (childPid > 0) killProcess(childPid);
    try {
      restoreCodexOverrides();
    } catch (error) {
      console.error(`Could not restore the Codex config: ${errorText(error)}`);
    }
  };
  const onSignal = (): void => {
    if (!started) rollback();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const applied = applyCodexOverrides(options.overrides);
    childPid = launchDetachedServe(options.cliEntry, options.port);
    const ready = await waitForHealth(options.port, options.healthTimeoutMs ?? 10_000, childPid);
    if (!ready) return { ok: false, reason: "unhealthy" };
    writeDaemonInfo({ pid: childPid, port: options.port });
    started = true;
    return { ok: true, pid: childPid, applied };
  } catch (error) {
    return { ok: false, reason: "failed", error: errorText(error) };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!started) rollback();
  }
}

/**
 * Ready only when /health answers with the child's own pid. A different
 * process on the same port (or a child that exited) is not our proxy.
 */
async function waitForHealth(port: number, timeoutMs: number, childPid: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childPid > 0 && !processAlive(childPid)) return false;
    if (childPid > 0 && (await healthPid(port)) === childPid) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function healthPid(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { pid?: unknown };
    return typeof body.pid === "number" ? body.pid : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  return daemonRunning({ pid, port: 0 });
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
