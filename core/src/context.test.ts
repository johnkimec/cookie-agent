import { describe, expect, it } from "vitest";
import {
  fitTokens,
  LOCAL_RETRIEVED_TOKEN_BUDGET,
  recentWithinBudget,
  renderRetrieved,
} from "./context.ts";
import type { Memory, TurnRecord } from "./memory/types.ts";

function turn(id: string, content: string): TurnRecord {
  return {
    id,
    sessionId: "ses",
    role: "user",
    content,
    tainted: false,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: null,
    latencyMs: null,
    createdAt: 1,
  };
}

describe("context budgets", () => {
  it("keeps the newest turns that fit", () => {
    const turns = [
      turn("old", "a".repeat(400)),
      turn("mid", "b".repeat(40)),
      turn("new", "c".repeat(40)),
    ];
    const kept = recentWithinBudget(turns, 30);
    expect(kept.map((row) => row.id)).toEqual(["mid", "new"]);
  });

  it("drops later memories once the retrieved budget is full", () => {
    const memories: Memory[] = [
      { id: "1", source: "turn", text: "m".repeat(200) },
      { id: "2", source: "turn", text: "n".repeat(20_000) },
    ];
    const block = renderRetrieved(memories, 80);
    expect(block).toContain("Retrieved memories:");
    expect(block).toContain("[turn]");
    expect(block).not.toContain("n".repeat(100));
    expect(LOCAL_RETRIEVED_TOKEN_BUDGET).toBe(1000);
    expect(fitTokens("abcdef", 1)).toBe("abcd");
  });
});
