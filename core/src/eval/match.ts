/** Case-insensitive, whitespace-collapsed substring. */

export function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface AnswerCheck {
  expectedFact: string;
  accept?: readonly string[];
  mustNotContain?: readonly string[];
}

/**
 * Pass when any accepted answer appears and no forbidden string appears.
 * `expectedFact` is always accepted. `accept` adds alternates.
 */
export function answerMatches(check: AnswerCheck, answer: string): boolean {
  const haystack = normalizeMatchText(answer);
  const accepted = [check.expectedFact, ...(check.accept ?? [])];
  const hit = accepted.some((item) => contains(haystack, item));
  const blocked = (check.mustNotContain ?? []).some((item) =>
    contains(haystack, item),
  );
  return hit && !blocked;
}

function contains(haystack: string, needle: string): boolean {
  const normalized = normalizeMatchText(needle);
  return normalized.length > 0 && haystack.includes(normalized);
}
