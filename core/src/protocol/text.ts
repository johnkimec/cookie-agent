/** Whitespace-separated word count used by the fake core's usage field. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export const FAKE_MODEL_ID = "fake-local";

export const FAKE_SERVER_NAME = "cookie-fake-core";

export const FAKE_SERVER_VERSION = "0.0.0";

/**
 * Canned reply the fake core streams. Three chunks so a client can see
 * more than one delta before chat.done. Not a model response.
 */
export const FAKE_REPLY_CHUNKS = [
  "I'm here. ",
  "This reply is from the fake core, ",
  "with no model loaded.",
] as const;

export function fakeReplyText(): string {
  return FAKE_REPLY_CHUNKS.join("");
}
