/**
 * Case-insensitive, whitespace-collapsed substring.
 * A space between a number and its unit is removed, so "170 g" and
 * "170g" are the same needle.
 */

export function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\d)\s+(?=[a-z])/g, "$1");
}

export interface AnswerCheck {
  expectedFact: string;
  accept?: readonly string[];
  mustNotContain?: readonly string[];
  question?: string;
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

/**
 * Why an `accept` entry is rejected, or null when it may ship.
 * After normalizing it must be at least 3 characters, contain a digit
 * or a word of 4 or more letters, and not appear in the question or
 * in any `mustNotContain` string.
 */
export function acceptIssue(check: AnswerCheck, entry: string): string | null {
  const normalized = normalizeMatchText(entry);
  if (normalized.length < 3) {
    return "shorter than 3 characters";
  }
  const hasDigit = /\d/.test(normalized);
  const hasWord = /[a-z]{4,}/.test(normalized);
  if (!hasDigit && !hasWord) {
    return "needs a digit or a word of 4 or more letters";
  }
  const question = normalizeMatchText(check.question ?? "");
  if (contains(question, normalized)) {
    return "appears in the question";
  }
  for (const blocked of check.mustNotContain ?? []) {
    if (contains(normalizeMatchText(blocked), normalized)) {
      return "appears in mustNotContain";
    }
  }
  return null;
}

/** Boundary match of `needle` inside `haystack`. Both sides are normalized. */
export function textContains(haystack: string, needle: string): boolean {
  return contains(normalizeMatchText(haystack), needle);
}

function contains(haystack: string, needle: string): boolean {
  const normalized = normalizeMatchText(needle);
  if (normalized.length === 0) {
    return false;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "u",
  );
  return pattern.test(haystack);
}
