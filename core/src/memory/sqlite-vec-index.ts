import type Database from "better-sqlite3";
import type { VectorHit, VectorTable } from "./types.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

/**
 * sqlite-vec 0.1.9 `vec0` tables from migration 001.
 * Distance is the table default, L2. Rows are L2-normalized by the
 * embedder, so nearer L2 is nearer cosine. Ranks match the in-memory
 * cosine index. The numeric distance does not: orthogonal unit vectors
 * are about 1.414 here and 1 on the fake.
 * `delete` removes each id from both tables. Missing ids are ignored.
 */
export class SqliteVecIndex implements VectorIndex {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async upsert(
    table: VectorTable,
    id: string,
    embedding: Float32Array,
  ): Promise<void> {
    assertDimensions(embedding, "embedding");
    const write = this.db.transaction(() => {
      this.deleteFrom(table, id);
      this.insert(table, id, embedding);
    });
    write();
  }

  async knn(
    table: VectorTable,
    query: Float32Array,
    k: number,
  ): Promise<VectorHit[]> {
    assertDimensions(query, "query");
    if (k <= 0) {
      return [];
    }
    const idColumn = table === "vec_facts" ? "fact_id" : "chunk_id";
    // vec0 allows only `ORDER BY distance` on a KNN query.
    const rows = this.db
      .prepare(
        `SELECT ${idColumn} AS id, distance FROM ${table}
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(query, k) as Array<{ id: string; distance: number }>;
    return rows
      .map((row) => ({ id: row.id, distance: row.distance }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.id.localeCompare(right.id),
      );
  }

  async has(table: VectorTable, id: string): Promise<boolean> {
    if (table === "vec_facts") {
      const row = this.db
        .prepare("SELECT fact_id FROM vec_facts WHERE fact_id = ?")
        .get(id);
      return row !== undefined;
    }
    const row = this.db
      .prepare("SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?")
      .get(id);
    return row !== undefined;
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const write = this.db.transaction(() => {
      for (const id of ids) {
        this.deleteFrom("vec_facts", id);
        this.deleteFrom("vec_chunks", id);
      }
    });
    write();
  }

  private deleteFrom(table: VectorTable, id: string): void {
    if (table === "vec_facts") {
      this.db.prepare("DELETE FROM vec_facts WHERE fact_id = ?").run(id);
      return;
    }
    this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(id);
  }

  private insert(
    table: VectorTable,
    id: string,
    embedding: Float32Array,
  ): void {
    if (table === "vec_facts") {
      this.db
        .prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)")
        .run(id, embedding);
      return;
    }
    this.db
      .prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)")
      .run(id, embedding);
  }
}

function assertDimensions(vector: Float32Array, label: string): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${label} length ${vector.length} is not ${EMBEDDING_DIMENSIONS}`,
    );
  }
}
