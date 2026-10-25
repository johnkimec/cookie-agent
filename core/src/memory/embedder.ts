import { EMBEDDING_DIMENSIONS } from "./types.ts";

/** Text to a 768-d vector. CI uses a fake. The local model is a later step. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

/** Deterministic offline embedder. Same text always yields the same vector. */
export class FakeEmbedder implements Embedder {
  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(EMBEDDING_DIMENSIONS);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
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
