// Shared device-code sign-in orchestration for the CLI and the TUI: request
// a device code, surface it, open the browser, and complete the flow with
// progress callbacks. Callers keep their own org selection and summary text.

import { DEFAULT_CONSOLE_SERVER, type ConsoleSession, type OpenCodeMode } from "./protocol";
import type { OpenCodeAuth } from "./auth";

async function openBrowser(url: string): Promise<void> {
  try {
    const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    void proc.exited;
  } catch { /* macOS only; the URL is printed/checked by callers */ }
}

export interface DeviceSignInHooks {
  /** Shown (and printable) before the browser opens. */
  onDeviceCode?: (code: { userCode: string; verificationUrl: string }) => void;
  /** Polling progress in seconds. */
  onPoll?: (elapsedSeconds: number) => void;
}

/**
 * One device-code sign-in for a mode slot: request, surface, open, poll,
 * persist. Org selection stays the caller's business (CLI prompts; the TUI
 * offers switching from the slot list).
 */
export async function deviceSignIn(
  auth: OpenCodeAuth,
  mode: OpenCodeMode,
  server: string = DEFAULT_CONSOLE_SERVER,
  hooks: DeviceSignInHooks = {},
): Promise<ConsoleSession> {
  const device = await auth.requestDeviceCode(server);
  hooks.onDeviceCode?.({ userCode: device.userCode, verificationUrl: device.verificationUrl });
  await openBrowser(device.verificationUrl).catch(() => { /* browser open is best effort */ });
  return await auth.completeDeviceSignIn(device, mode, undefined, hooks.onPoll);
}