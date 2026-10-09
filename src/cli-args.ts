import type { OpenCodeMode } from "./protocol";

export type Flags = Record<string, string | boolean>;

export interface Args {
  command: string;
  flags: Flags;
}

export function parseArgs(argv: string[]): Args {
  const [command = "tui", ...rest] = argv;
  const flags: Flags = {};
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

/** `--mode` must name a slot; a bare flag or an unknown name is an error, never a default. */
export function parseModeFlag(flags: Flags, fallback?: OpenCodeMode): OpenCodeMode | undefined {
  const value = flags.mode;
  if (value === undefined) return fallback;
  if (value === true) throw new Error("--mode needs a value: console or go");
  if (value !== "console" && value !== "go") throw new Error(`Unknown mode: ${value} (use console or go)`);
  return value;
}

export function parseIntFlag(flags: Flags, name: string, fallback: number, bounds: { min: number; max: number }): number {
  const value = flags[name];
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`--${name} needs a whole number from ${bounds.min} to ${bounds.max}`);
  }
  return parsed;
}

/** The org index the picker chose: empty input picks the first org. */
export function parseOrgChoice(answer: string, count: number): number | undefined {
  const value = answer.trim();
  if (!value) return 0;
  const index = Number.parseInt(value, 10) - 1;
  return index >= 0 && index < count ? index : undefined;
}
