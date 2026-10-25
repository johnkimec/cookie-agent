import type Database from "better-sqlite3";
import type { Embedder } from "./embedder.ts";
import { prefixQuery } from "./http-embedder.ts";
import type { Retrieve } from "./retrieve.ts";
import { fuseRrf } from "./rrf.ts";
import type { Memory, MemorySource } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

/** How many fused rows are sent to the reranker. */
export const FUSION_POOL = 20;

/** Rows kept after rerank, or after fusion when rerank is off. */
export const RETRIEVAL_LIMIT = 8;

/**
 * Default weights. Vector-only beat even weights on the Mac fixtures,
 * so BM25's weight is 0 until someone sets `COOKIE_RRF_BM25`.
 * Set both to 1 for classic even reciprocal-rank fusion.
 * `COOKIE_RRF_VECTOR` defaults to 1. When the embedder is down the
 * vector leg is dropped and BM25 is used even if its weight is 0.
 */
export interface RrfWeights {
  vector: number;
  bm25: number;
}

export const DEFAULT_RRF_WEIGHTS: RrfWeights = { vector: 1, bm25: 0 };

export function readRrfWeights(
  env: NodeJS.ProcessEnv = process.env,
): RrfWeights {
  return {
    vector: readWeight(
      env.COOKIE_RRF_VECTOR,
      DEFAULT_RRF_WEIGHTS.vector,
      "COOKIE_RRF_VECTOR",
    ),
    bm25: readWeight(
      env.COOKIE_RRF_BM25,
      DEFAULT_RRF_WEIGHTS.bm25,
      "COOKIE_RRF_BM25",
    ),
  };
}

export interface HybridRetrieverOptions {
  db: Database.Database;
  vectors: VectorIndex;
  embedder: Embedder;
  weights?: RrfWeights;
  now?: () => number;
  /** False skips the vector leg. A thrown embed also skips it. */
  available?: () => Promise<boolean>;
  rerank?: (query: string, candidates: readonly Memory[]) => Promise<Memory[]>;
  /** Per-leg candidate cap and the fused list sent to rerank. */
  pool?: number;
  limit?: number;
}

interface FactRow {
  id: string;
  text: string;
  superseded_by: string | null;
  valid_until: number | null;
}

/**
 * BM25 over facts and turns, kNN over vec_facts and vec_chunks, then RRF.
 * Facts with `superseded_by` set, or `valid_until` at or before now,
 * are removed inside each leg before fusion so they do not take a top-K slot.
 * Those columns are on `facts` in migration 001.
 */
export class HybridRetriever {
  private readonly db: Database.Database;
  private readonly vectors: VectorIndex;
  private readonly embedder: Embedder;
  private readonly weights: RrfWeights;
  private readonly now: () => number;
  private readonly available: () => Promise<boolean>;
  private readonly rerank: HybridRetrieverOptions["rerank"];
  private readonly pool: number;
  private readonly limit: number;

  constructor(options: HybridRetrieverOptions) {
    this.db = options.db;
    this.vectors = options.vectors;
    this.embedder = options.embedder;
    this.weights = options.weights ?? DEFAULT_RRF_WEIGHTS;
    this.now = options.now ?? (() => Date.now());
    this.available = options.available ?? (async () => true);
    this.rerank = options.rerank;
    this.pool = options.pool ?? FUSION_POOL;
    this.limit = options.limit ?? RETRIEVAL_LIMIT;
  }

  readonly retrieve: Retrieve = async (query) => {
    const match = ftsOrQuery(query);
    const now = this.now();
    const facts = match === "" ? [] : this.bm25Facts(match, now);
    const turns = match === "" ? [] : this.bm25Turns(match);
    const byId = new Map<string, Memory>();
    for (const memory of [...facts, ...turns]) {
      byId.set(memory.id, memory);
    }
    let vectorUp = false;
    try {
      vectorUp = await this.available();
    } catch {
      vectorUp = false;
    }
    const vectorFacts: Memory[] = [];
    const vectorChunks: Memory[] = [];
    if (vectorUp && query.trim() !== "") {
      try {
        const embedding = await this.embedder.embed(prefixQuery(query));
        vectorFacts.push(...(await this.vectorFacts(embedding, now)));
        vectorChunks.push(...(await this.vectorChunks(embedding)));
      } catch {
        vectorUp = false;
      }
    }
    for (const memory of [...vectorFacts, ...vectorChunks]) {
      if (!byId.has(memory.id)) {
        byId.set(memory.id, memory);
      }
    }
    const bm25Weight = vectorUp
      ? this.weights.bm25
      : Math.max(this.weights.bm25, 1);
    const fused = fuseRrf([
      { weight: bm25Weight, ids: facts.map((memory) => memory.id) },
      { weight: bm25Weight, ids: turns.map((memory) => memory.id) },
      {
        weight: vectorUp ? this.weights.vector : 0,
        ids: vectorFacts.map((memory) => memory.id),
      },
      {
        weight: vectorUp ? this.weights.vector : 0,
        ids: vectorChunks.map((memory) => memory.id),
      },
    ]).slice(0, this.pool);
    const candidates: Memory[] = [];
    for (const row of fused) {
      const memory = byId.get(row.id);
      if (memory !== undefined) {
        candidates.push(memory);
      }
    }
    let ranked = candidates.slice(0, this.limit);
    if (this.rerank !== undefined) {
      try {
        ranked = await this.rerank(query, candidates);
      } catch {
        ranked = candidates.slice(0, this.limit);
      }
    }
    return dedupeText(ranked).slice(0, this.limit);
  };

  private bm25Facts(match: string, now: number): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.text, f.superseded_by, f.valid_until
         FROM facts_fts
         JOIN facts f ON f.rowid = facts_fts.rowid
         WHERE facts_fts MATCH ?
           AND f.superseded_by IS NULL
           AND (f.valid_until IS NULL OR f.valid_until > ?)
         ORDER BY bm25(facts_fts), f.created_at, f.id
         LIMIT ?`,
      )
      .all(match, now, this.pool) as FactRow[];
    return rows.map((row) => memoryFrom(row.id, row.text, "fact"));
  }

  private bm25Turns(match: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.content AS text
         FROM turns_fts
         JOIN turns t ON t.rowid = turns_fts.rowid
         WHERE turns_fts MATCH ?
         ORDER BY bm25(turns_fts), t.created_at, t.id
         LIMIT ?`,
      )
      .all(match, this.pool) as Array<{ id: string; text: string }>;
    return rows.map((row) => memoryFrom(row.id, row.text, "turn"));
  }

  private async vectorFacts(
    embedding: Float32Array,
    now: number,
  ): Promise<Memory[]> {
    const hits = await this.knnUntil(embedding, "vec_facts", (id) => {
      const row = this.db
        .prepare(
          "SELECT id, text, superseded_by, valid_until FROM facts WHERE id = ?",
        )
        .get(id) as FactRow | undefined;
      if (row === undefined || !liveFact(row, now)) {
        return null;
      }
      return memoryFrom(row.id, row.text, "fact");
    });
    return hits;
  }

  private async vectorChunks(embedding: Float32Array): Promise<Memory[]> {
    return this.knnUntil(embedding, "vec_chunks", (id) => {
      const row = this.db
        .prepare("SELECT chunk_id, text FROM chunks WHERE chunk_id = ?")
        .get(id) as { chunk_id: string; text: string } | undefined;
      if (row === undefined || row.text.trim() === "") {
        return null;
      }
      return memoryFrom(row.chunk_id, row.text, "chunk");
    });
  }

  /**
   * Ask kNN for more rows until `pool` live hits remain or the table is exhausted.
   * Dead facts are skipped before they count toward the pool.
   */
  private async knnUntil(
    embedding: Float32Array,
    table: "vec_facts" | "vec_chunks",
    accept: (id: string) => Memory | null,
  ): Promise<Memory[]> {
    let ask = Math.max(this.pool, 1);
    let rows = await this.vectors.knn(table, embedding, ask);
    let live = rows
      .map((hit) => accept(hit.id))
      .filter((memory): memory is Memory => memory !== null);
    while (live.length < this.pool && rows.length === ask && ask < 4096) {
      ask *= 2;
      rows = await this.vectors.knn(table, embedding, ask);
      live = rows
        .map((hit) => accept(hit.id))
        .filter((memory): memory is Memory => memory !== null);
    }
    return live.slice(0, this.pool);
  }
}

export function ftsOrQuery(text: string): string {
  const tokens = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function liveFact(row: FactRow, now: number): boolean {
  if (row.superseded_by !== null && row.superseded_by !== "") {
    return false;
  }
  if (row.valid_until !== null && row.valid_until <= now) {
    return false;
  }
  return true;
}

function memoryFrom(id: string, text: string, source: MemorySource): Memory {
  return { id, text, source };
}

function dedupeText(memories: readonly Memory[]): Memory[] {
  const seen = new Set<string>();
  const out: Memory[] = [];
  for (const memory of memories) {
    const key = memory.text.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(memory);
  }
  return out;
}

function readWeight(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`${name} must be a number >= 0`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number >= 0`);
  }
  return value;
}
