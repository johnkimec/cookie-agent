import { describe, expect, it } from "vitest";
import type { ProfileRecord } from "./derived.ts";
import {
  capProfile,
  estimateTokens,
  PROFILE_TOKEN_CAP,
  profileTokens,
  renderProfile,
} from "./profile-cap.ts";

function row(
  key: string,
  value: string,
  pinned: boolean,
  updatedAt: number,
): ProfileRecord {
  return {
    key,
    value,
    pinned,
    shareable: true,
    sourceTurn: null,
    updatedAt,
  };
}

describe("profile cap", () => {
  it("keeps pinned keys and drops unpinned rows past 800 tokens", () => {
    const pinned = [
      row("school", "ECE", true, 1),
      row("name", "John", true, 2),
    ];
    const loose = Array.from({ length: 40 }, (_, index) =>
      row(`note_${index}`, "x".repeat(200), false, index),
    );
    const capped = capProfile([...loose, ...pinned]);
    expect(profileTokens(capped)).toBeLessThanOrEqual(PROFILE_TOKEN_CAP);
    expect(capped.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["name", "school"]),
    );
    expect(capped.some((entry) => entry.key.startsWith("note_"))).toBe(true);
    expect(
      capped.filter((entry) => entry.key.startsWith("note_")).length,
    ).toBeLessThan(loose.length);
    const rendered = renderProfile(capped);
    expect(estimateTokens(rendered)).toBe(profileTokens(capped));
  });

  it("shrinks a huge pinned value so the key survives inside the cap", () => {
    const capped = capProfile([row("bio", "y".repeat(10_000), true, 1)]);
    expect(capped.map((entry) => entry.key)).toEqual(["bio"]);
    expect(profileTokens(capped)).toBeLessThanOrEqual(PROFILE_TOKEN_CAP);
    expect(capped[0]?.value.length).toBeLessThan(10_000);
  });
});
