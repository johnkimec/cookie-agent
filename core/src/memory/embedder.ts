import { DOCUMENT_PREFIX, QUERY_PREFIX } from "./http-embedder.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

/** Text to a 768-d vector. CI uses a fake. The local model is HTTP. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

/**
 * Deterministic offline embedder. Same text always yields the same vector.
 * The nomic prefixes are stripped first so a document vector and a query
 * vector for the same words match. The HTTP embedder must not strip them.
 */
export class FakeEmbedder implements Embedder {
  async embed(text: string): Promise<Float32Array> {
    const bare = stripEmbedPrefix(text);
    const out = new Float32Array(EMBEDDING_DIMENSIONS);
    let hash = 2166136261;
    for (let index = 0; index < bare.length; index += 1) {
      hash ^= bare.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    for (let index = 0; index < out.length; index += 1) {
      hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
      hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
      hash ^= hash >>> 16;
      out[index] = ((hash >>> 0) % 2000) / 1000 - 1;
    }
    return out;
  }
}

function stripEmbedPrefix(text: string): string {
  if (text.startsWith(DOCUMENT_PREFIX)) {
    return text.slice(DOCUMENT_PREFIX.length);
  }
  if (text.startsWith(QUERY_PREFIX)) {
    return text.slice(QUERY_PREFIX.length);
  }
  return text;
}
