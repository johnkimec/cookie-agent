import type { VectorHit, VectorTable } from "./types.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

/**
 * kNN over vec_facts and vec_chunks. sqlite-vec is one implementation.
 * This fake is the brute-force cosine fallback the design doc requires.
 * Distance is 1 minus cosine similarity, so an identical vector is 0.
 */
export interface VectorIndex {
  upsert(
    table: VectorTable,
    id: string,
    embedding: Float32Array,
  ): Promise<void>;
  knn(table: VectorTable, query: Float32Array, k: number): Promise<VectorHit[]>;
  /**
   * Drop these ids from every table. sqlite-vec's implementation is a
   * later PR. The in-memory fake removes them so forget and rebuild
   * do not leave stale hits.
   */
  delete(ids: string[]): Promise<void>;
}

function cosineDistance(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 1;
  }
  const cosine = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return 1 - cosine;
}

export class InMemoryVectorIndex implements VectorIndex {
  private readonly tables = new Map<VectorTable, Map<string, Float32Array>>();

  async upsert(
    table: VectorTable,
    id: string,
    embedding: Float32Array,
  ): Promise<void> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding length ${embedding.length} is not ${EMBEDDING_DIMENSIONS}`,
      );
    }
    const rows = this.tables.get(table) ?? new Map<string, Float32Array>();
    rows.set(id, new Float32Array(embedding));
    this.tables.set(table, rows);
  }

  async knn(
    table: VectorTable,
    query: Float32Array,
    k: number,
  ): Promise<VectorHit[]> {
    if (query.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `query length ${query.length} is not ${EMBEDDING_DIMENSIONS}`,
      );
    }
    if (k <= 0) {
      return [];
    }
    const rows = this.tables.get(table);
    if (rows === undefined) {
      return [];
    }
    const hits: VectorHit[] = [];
    for (const [id, embedding] of rows) {
      hits.push({ id, distance: cosineDistance(query, embedding) });
    }
    hits.sort(
      (left, right) =>
        left.distance - right.distance || left.id.localeCompare(right.id),
    );
    return hits.slice(0, k);
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const drop = new Set(ids);
    for (const rows of this.tables.values()) {
      for (const id of drop) {
        rows.delete(id);
      }
    }
  }
}
