import { estimateTokens } from "./memory/chunk.ts";
import type { Memory, TurnRecord } from "./memory/types.ts";

/** Design-doc local budget for retrieved memories. */
export const LOCAL_RETRIEVED_TOKEN_BUDGET = 1000;

/** Design-doc local budget for recent turns in this session. */
export const LOCAL_RECENT_TURN_TOKEN_BUDGET = 3000;

/**
 * Newest turns that fit in `budget`, oldest first.
 * A single oversized turn is shortened so the prompt still has a tail.
 */
export function recentWithinBudget(
  turns: readonly TurnRecord[],
  budget: number = LOCAL_RECENT_TURN_TOKEN_BUDGET,
): TurnRecord[] {
  if (budget <= 0) {
    return [];
  }
  const kept: TurnRecord[] = [];
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) {
      continue;
    }
    const cost = Math.max(1, estimateTokens(turn.content));
    if (kept.length > 0 && tokens + cost > budget) {
      break;
    }
    if (kept.length === 0 && cost > budget) {
      kept.push({ ...turn, content: fitTokens(turn.content, budget) });
      break;
    }
    kept.push(turn);
    tokens += cost;
  }
  return kept.reverse();
}

/**
 * Memories in rank order, dropped from the tail once the budget is full.
 * Empty when there is nothing to say.
 */
export function renderRetrieved(
  memories: readonly Memory[],
  budget: number = LOCAL_RETRIEVED_TOKEN_BUDGET,
): string {
  if (budget <= 0 || memories.length === 0) {
    return "";
  }
  const header = "Retrieved memories:";
  let tokens = estimateTokens(header);
  const lines: string[] = [];
  for (const memory of memories) {
    let line = `- [${memory.source}] ${memory.text}`;
    let cost = Math.max(1, estimateTokens(line));
    if (lines.length === 0 && tokens + cost > budget) {
      const room = budget - tokens;
      if (room <= 0) {
        break;
      }
      line = fitTokens(line, room);
      cost = Math.max(1, estimateTokens(line));
    }
    if (lines.length > 0 && tokens + cost > budget) {
      break;
    }
    lines.push(line);
    tokens += cost;
  }
  if (lines.length === 0) {
    return "";
  }
  return `${header}\n${lines.join("\n")}`;
}

export function fitTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars).trim();
}
