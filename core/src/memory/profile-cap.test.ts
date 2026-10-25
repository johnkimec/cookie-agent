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

  it("keeps a huge pinned value whole and hides unpinned overflow", () => {
    const logs: string[] = [];
    const capped = capProfile(
      [
        row("bio", "y".repeat(10_000), true, 1),
        row("note", "x".repeat(200), false, 2),
      ],
      PROFILE_TOKEN_CAP,
      (message) => {
        logs.push(message);
      },
    );
    expect(capped.map((entry) => entry.key)).toEqual(["bio"]);
    expect(capped[0]?.value).toHaveLength(10_000);
    expect(logs).toEqual([
      "profile cap: pinned rows exceed 800 tokens; keeping pinned values whole",
    ]);
    expect(logs.join("\n")).not.toContain("y".repeat(20));
  });
});
