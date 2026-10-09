import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs, parseIntFlag, parseModeFlag, parseOrgChoice } from "../src/cli-args";
import { maskKey } from "../src/secrets";
import { tempRoot } from "./helpers";

describe("parseModeFlag", () => {
  test("uses the fallback only when the flag is absent", () => {
    expect(parseModeFlag({}, "console")).toBe("console");
    expect(parseModeFlag({})).toBeUndefined();
    expect(parseModeFlag({ mode: "go" })).toBe("go");
  });

  test("rejects a bare --mode and unknown slot names", () => {
    expect(() => parseModeFlag({ mode: true })).toThrow(/needs a value/);
    expect(() => parseModeFlag({ mode: "zen" }, "console")).toThrow(/Unknown mode: zen/);
  });
});

describe("parseIntFlag", () => {
  test("accepts whole numbers within bounds and falls back when absent", () => {
    expect(parseIntFlag({ port: "9000" }, "port", 8788, { min: 1, max: 65535 })).toBe(9000);
    expect(parseIntFlag({}, "port", 8788, { min: 1, max: 65535 })).toBe(8788);
  });

  test("rejects bare, non-numeric, fractional, and out-of-range values", () => {
    const bounds = { min: 1, max: 65535 };
    expect(() => parseIntFlag({ port: true }, "port", 8788, bounds)).toThrow(/whole number/);
    expect(() => parseIntFlag({ port: "abc" }, "port", 8788, bounds)).toThrow(/whole number/);
    expect(() => parseIntFlag({ port: "1.5" }, "port", 8788, bounds)).toThrow(/whole number/);
    expect(() => parseIntFlag({ port: "70000" }, "port", 8788, bounds)).toThrow(/whole number/);
    expect(() => parseIntFlag({ lines: "NaN" }, "lines", 30, { min: 1, max: 10000 })).toThrow(/whole number/);
  });
});

describe("parseArgs", () => {
  test("pairs flags with values and treats a trailing flag as boolean", () => {
    const parsed = parseArgs(["logs", "--lines", "5", "--no-launch"]);
    expect(parsed.command).toBe("logs");
    expect(parsed.flags).toEqual({ lines: "5", "no-launch": true });
  });

  test("defaults the command to tui", () => {
    expect(parseArgs([]).command).toBe("tui");
  });
});

describe("parseOrgChoice", () => {
  test("takes the typed number, defaults empty input to the first org, and rejects out-of-range input", () => {
    expect(parseOrgChoice("2\n", 3)).toBe(1);
    expect(parseOrgChoice("  ", 3)).toBe(0);
    expect(parseOrgChoice("", 3)).toBe(0);
    expect(parseOrgChoice("4", 3)).toBeUndefined();
    expect(parseOrgChoice("0", 3)).toBeUndefined();
    expect(parseOrgChoice("x", 3)).toBeUndefined();
  });
});

describe("maskKey", () => {
  test("never shows a short key in full", () => {
    expect(maskKey("12345678")).toBe("••••••");
    expect(maskKey("sk-abcdef1234567890")).toBe("…7890");
    expect(maskKey(undefined)).toBe("not set");
  });
});

describe("daemon pid validation", () => {
  const home = tempRoot("oc3-daemon-pid-test");

  test("ignores pids that cannot name a single process", async () => {
    const previous = process.env.OC3_HOME;
    process.env.OC3_HOME = home;
    mkdirSync(home, { recursive: true });
    const { readDaemonInfo } = await import("../src/daemon");
    try {
      for (const pid of [0, -1, 1.5, "7"]) {
        writeFileSync(`${home}/daemon.json`, JSON.stringify({ pid, port: 8788 }));
        expect(readDaemonInfo()).toBeUndefined();
      }
      writeFileSync(`${home}/daemon.json`, JSON.stringify({ pid: 4242, port: 8788 }));
      expect(readDaemonInfo()).toEqual({ pid: 4242, port: 8788 });
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OC3_HOME;
      else process.env.OC3_HOME = previous;
    }
  });
});
