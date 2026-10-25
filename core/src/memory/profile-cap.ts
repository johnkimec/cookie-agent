import type { ProfileRecord } from "./derived.ts";

/** Design doc: profile is at most 800 tokens, pinned keys first. */
export const PROFILE_TOKEN_CAP = 800;

/**
 * Four characters per token. Deterministic, so CI can assert the cap
 * without a tokenizer. The same estimator is what consolidation enforces.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function renderProfile(rows: readonly ProfileRecord[]): string {
  return rows.map((row) => `${row.key}: ${row.value}`).join("\n");
}

export function profileTokens(rows: readonly ProfileRecord[]): number {
  return estimateTokens(renderProfile(rows));
}

/**
 * Pinned keys are kept, in key order, and shrunk from the longest value
 * until the block fits. Unpinned keys are added newest-first only when
 * the whole row fits. The result is a new list; inputs are not mutated.
 */
export function capProfile(
  rows: readonly ProfileRecord[],
  cap: number = PROFILE_TOKEN_CAP,
): ProfileRecord[] {
  const pinned = rows
    .filter((row) => row.pinned)
    .map(clone)
    .sort((left, right) => left.key.localeCompare(right.key));
  const loose = rows
    .filter((row) => !row.pinned)
    .map(clone)
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.key.localeCompare(right.key),
    );
  const selected = pinned.map(clone);
  if (profileTokens(selected) > cap) {
    shrinkToCap(selected, cap);
    return selected;
  }
  for (const row of loose) {
    if (profileTokens([...selected, row]) <= cap) {
      selected.push(row);
    }
  }
  return selected;
}

function shrinkToCap(rows: ProfileRecord[], cap: number): void {
  while (profileTokens(rows) > cap && rows.length > 0) {
    let longest = 0;
    for (let index = 1; index < rows.length; index += 1) {
      const current = rows[index];
      const best = rows[longest];
      if (current !== undefined && best !== undefined) {
        if (current.value.length > best.value.length) {
          longest = index;
        }
      }
    }
    const row = rows[longest];
    if (row === undefined) {
      return;
    }
    if (row.value.length === 0) {
      rows.splice(longest, 1);
      continue;
    }
    const nextLength = Math.max(0, row.value.length - 4);
    row.value = row.value.slice(0, nextLength);
  }
}

function clone(row: ProfileRecord): ProfileRecord {
  return { ...row };
}
