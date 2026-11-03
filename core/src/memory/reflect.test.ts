import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFLECT_IDLE_MS,
  readReflectIdleMs,
  reflectHookRequested,
} from "./reflect.ts";

describe("reflect idle env", () => {
  it("returns 600000 when unset and 0 when the value is 0", () => {
    expect(DEFAULT_REFLECT_IDLE_MS).toBe(600_000);
    expect(readReflectIdleMs({})).toBe(600_000);
    expect(readReflectIdleMs({ COOKIE_REFLECT_IDLE_MS: "" })).toBe(600_000);
    expect(readReflectIdleMs({ COOKIE_REFLECT_IDLE_MS: "0" })).toBe(0);
    expect(reflectHookRequested({})).toBe(false);
    expect(reflectHookRequested({ COOKIE_REFLECT_IDLE_MS: "" })).toBe(false);
    expect(reflectHookRequested({ COOKIE_REFLECT_IDLE_MS: "0" })).toBe(true);
  });

  it("rejects a value that is not a non-negative integer", () => {
    expect(() => readReflectIdleMs({ COOKIE_REFLECT_IDLE_MS: "soon" })).toThrow(
      /COOKIE_REFLECT_IDLE_MS/,
    );
  });
});
