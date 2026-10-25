import type { Memory } from "./types.ts";

/** Hybrid retrieval. BM25, kNN, and rerank are later steps. */
export type Retrieve = (query: string) => Promise<Memory[]>;

/** Substring match over a fixed list. Enough to pin the function shape. */
export class InMemoryRetriever {
  private readonly memories: Memory[] = [];

  add(memory: Memory): void {
    this.memories.push({ ...memory });
  }

  readonly retrieve: Retrieve = async (query) => {
    const needle = query.toLowerCase();
    return this.memories
      .filter((memory) => memory.text.toLowerCase().includes(needle))
      .map((memory) => ({ ...memory }));
  };
}
