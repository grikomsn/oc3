import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAuth } from "../src/auth";
import { saveModeSession } from "../src/store";
import { sessionFixture } from "./helpers";

let home: string;
let previousHome: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "oc3-single-flight-"));
  previousHome = process.env.OC3_HOME;
  process.env.OC3_HOME = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OC3_HOME;
  else process.env.OC3_HOME = previousHome;
});

function expiredConsoleSession(token: string) {
  return { ...sessionFixture({ token }), expiresAt: Date.now() - 1_000 };
}

function countingFetcher(respond: () => Response | Promise<Response>): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input));
    await Bun.sleep(25);
    return respond();
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("concurrent credential refresh", () => {
  test("concurrent callers share one refresh request and one token", async () => {
    saveModeSession("console", expiredConsoleSession("stale-token"));
    const { fetcher, calls } = countingFetcher(() =>
      Response.json({ access_token: "fresh-token", refresh_token: "rotated-refresh", expires_in: 3600 }));
    const auth = new OpenCodeAuth(fetcher);
    const credentials = await Promise.all(Array.from({ length: 5 }, () => auth.getCredential("console")));
    expect(calls).toHaveLength(1);
    expect(new Set(credentials.map((credential) => credential.token))).toEqual(new Set(["fresh-token"]));
  });

  test("a failed refresh rejects every concurrent caller with one request", async () => {
    saveModeSession("console", expiredConsoleSession("stale-token-2"));
    const { fetcher, calls } = countingFetcher(() => new Response("denied", { status: 401 }));
    const auth = new OpenCodeAuth(fetcher);
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => auth.getCredential("console")));
    expect(calls).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  test("a valid session never triggers a refresh", async () => {
    saveModeSession("console", sessionFixture({ token: "fresh-session" }));
    const { fetcher, calls } = countingFetcher(() => Response.json({}));
    const credential = await new OpenCodeAuth(fetcher).getCredential("console");
    expect(credential.token).toBe("fresh-session");
    expect(calls).toHaveLength(0);
  });
});
