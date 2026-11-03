import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clockFromEnv } from "./clock.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("eval clock file", () => {
  it("reads a new value on each call", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-clock-"));
    dirs.push(dir);
    const file = join(dir, "clock");
    writeFileSync(file, "1000\n");
    const now = clockFromEnv({ COOKIE_CLOCK_FILE: file });
    expect(now()).toBe(1000);
    writeFileSync(file, "2500\n");
    expect(now()).toBe(2500);
  });

  it("uses Date.now when the variable is unset", () => {
    const before = Date.now();
    const value = clockFromEnv({})();
    expect(value).toBeGreaterThanOrEqual(before);
  });
});
