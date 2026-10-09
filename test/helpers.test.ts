import { afterEach, describe, expect, test } from "bun:test";
import { envSaver } from "./helpers";

const KEY = "OC3_HELPERS_TEST_ENV";

afterEach(() => {
  delete process.env[KEY];
});

describe("envSaver", () => {
  test("restores the original value after repeated sets", () => {
    process.env[KEY] = "original";
    const env = envSaver();
    env.set(KEY, "first");
    env.set(KEY, "second");
    env.restore();
    expect(process.env[KEY]).toBe("original");
  });

  test("deletes keys that were unset before the first set", () => {
    delete process.env[KEY];
    const env = envSaver();
    env.set(KEY, "first");
    env.set(KEY, undefined);
    env.set(KEY, "second");
    env.restore();
    expect(process.env[KEY]).toBeUndefined();
  });

  test("starts fresh after restore", () => {
    process.env[KEY] = "original";
    const env = envSaver();
    env.set(KEY, "first");
    env.restore();
    process.env[KEY] = "changed";
    env.set(KEY, "second");
    env.restore();
    expect(process.env[KEY]).toBe("changed");
  });
});
