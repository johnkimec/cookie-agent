/** Product cap for one embedding input. nomic-embed-text-v1.5 can take more. */
export const MAX_CHUNK_TOKENS = 512;

/**
 * Characters counted as one token.
 * This over-counts typical English so a chunk stays under the token cap
 * without a model tokenizer in CI.
 */
export const CHARS_PER_TOKEN = 4;

/** `ceil(chars / 4)`. Empty text is 0 tokens. */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split `text` into pieces of at most `maxTokens` estimated tokens.
 * Splits on a space when one falls inside the window. A single run of
 * non-space longer than the window is cut at the character cap.
 * Whitespace-only text returns no chunks.
 */
export function chunkText(
  text: string,
  maxTokens: number = MAX_CHUNK_TOKENS,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || maxTokens <= 0) {
    return [];
  }
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) {
      cut = maxChars;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) {
      chunks.push(piece);
    }
    rest = rest.slice(cut).trim();
  }
  return chunks;
}
