/**
 * Case-insensitive, whitespace-collapsed substring.
 * A space before a known unit (`g`, `kg`, `lb`, `ml`, `am`, `pm`, `%`)
 * is removed, so "170 g" and "170g" are the same needle. Any other word
 * stays separate, so "10:30 in", "3 Bahen", "170 grams", and "10:30 a.m."
 * keep a letter-or-number boundary.
 * A space, NBSP (U+00A0), thin space (U+2009), or narrow no-break space
 * (U+202F) joins a digit to a following group of exactly three digits, so
 * "1 170" is "1170". "Nov 7 10:30" and "Day 3 170" stay split. A hyphen is
 * a boundary, so "-170 g" and "150-170 g" contain "170 g".
 */
export function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<![\p{L}] )(\d) (?=\d{3}(?!\d))/gu, "$1")
    .replace(/(\d)\s+(kg|lb|ml|am|pm|g|%)(?![\p{L}\p{N}])/gu, "$1$2");
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
  // A comma or dot next to a digit is not a boundary: "170 g" is inside
  // "1,170 g", and "5 kg" is inside ".5 kg" and "0.5 kg". A trailing "." is.
  const beforeDigit = /^\d/.test(normalized) ? "(?<![.,])" : "";
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?<!\\d[.,])${beforeDigit}${escaped}(?![\\p{L}\\p{N}])(?![.,]\\d)`,
    "u",
  );
  return pattern.test(haystack);
}
