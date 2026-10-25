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
 * Visible profile for a prompt. Pinned keys stay whole. When they alone
 * exceed the cap, every pinned value is kept and the overflow is logged.
 * Unpinned rows that do not fit are omitted from the result. Callers
 * hide those rows; they do not delete them from the store.
 */
export function capProfile(
  rows: readonly ProfileRecord[],
  cap: number = PROFILE_TOKEN_CAP,
  log: (message: string) => void = () => undefined,
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
  if (profileTokens(pinned) > cap) {
    log(
      `profile cap: pinned rows exceed ${cap} tokens; keeping pinned values whole`,
    );
    return pinned;
  }
  const selected = pinned.map(clone);
  for (const row of loose) {
    if (profileTokens([...selected, row]) <= cap) {
      selected.push(row);
    }
  }
  return selected;
}

function clone(row: ProfileRecord): ProfileRecord {
  return { ...row };
}
