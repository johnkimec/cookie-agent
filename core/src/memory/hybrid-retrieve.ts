import type Database from "better-sqlite3";
import type { Embedder } from "./embedder.ts";
import { prefixQuery } from "./http-embedder.ts";
import type { Retrieve } from "./retrieve.ts";
import { fuseRrf } from "./rrf.ts";
import type { Memory, MemorySource } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

/** sqlite-vec rejects `k` above this. Doubling past it used to throw. */
export const KNN_MAX_K = 4096;

/** How many fused rows are sent to the reranker. */
export const FUSION_POOL = 20;

/** Rows kept after rerank, or after fusion when rerank is off. */
export const RETRIEVAL_LIMIT = 8;

/**
 * Default weights are even: vector 1 and BM25 1.
 * Real history is full of exact codes, ids, and numbers that BM25
 * finds and embeddings miss, so hybrid fusion stays on.
 * `COOKIE_RRF_VECTOR` and `COOKIE_RRF_BM25` override either weight.
 * When the embedder is down the vector leg is dropped and BM25 is
 * used even if its weight was set to 0.
 */
export interface RrfWeights {
  vector: number;
  bm25: number;
}

export const DEFAULT_RRF_WEIGHTS: RrfWeights = { vector: 1, bm25: 1 };

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
  rerank?: (
    query: string,
    candidates: readonly Memory[],
    signal?: AbortSignal,
  ) => Promise<Memory[]>;
  /** Per-leg candidate cap and the fused list sent to rerank. */
  pool?: number;
  limit?: number;
  /**
   * Store from #18. `forgottenTurnIds()` is read only when that method
   * is present. It is not part of `MemoryStore` on this branch.
   */
  store?: unknown;
}

interface FactRow {
  id: string;
  text: string;
  superseded_by: string | null;
  valid_until: number | null;
  created_at: number;
}

/**
 * BM25 over facts and turns, kNN over vec_facts and vec_chunks, then RRF.
 * Facts with `superseded_by` set, or `valid_until` at or before now,
 * are removed inside each leg before fusion so they do not take a top-K slot.
 * Those columns are on `facts` in migration 001.
 * When the store exposes `forgottenTurnIds()`, turns with those ids, chunks
 * derived from them, and session summaries derived from them are removed
 * in both legs before fusion as well. The vector leg over-fetches so a
 * forgotten row does not consume k.
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
  private readonly store: unknown;

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
    this.store = options.store ?? null;
  }

  readonly retrieve: Retrieve = async (query, signal, omitTurnIds) => {
    if (isAborted(signal)) {
      return [];
    }
    const match = ftsOrQuery(query);
    const now = this.now();
    const forgotten = readForgottenTurnIds(this.store);
    const omit = omitTurnIds ?? new Set<string>();
    const facts = match === "" ? [] : this.bm25Facts(match, now);
    const turns =
      match === "" ? [] : this.bm25Turns(match, forgotten, omit, query);
    const summaries = match === "" ? [] : this.bm25Summaries(query, forgotten);
    const byId = new Map<string, Memory>();
    for (const memory of [...facts, ...turns, ...summaries]) {
      remember(byId, memory);
    }
    let vectorUp = false;
    try {
      vectorUp = await this.available();
    } catch {
      vectorUp = false;
    }
    if (isAborted(signal)) {
      return [];
    }
    const vectorFacts: Memory[] = [];
    let vectorChunks: Memory[] = [];
    if (vectorUp && query.trim() !== "") {
      let embedding: Float32Array | undefined;
      try {
        embedding = await embedWithSignal(
          this.embedder.embed(prefixQuery(query)),
          signal,
        );
      } catch {
        embedding = undefined;
        if (isAborted(signal)) {
          return [];
        }
        vectorUp = false;
      }
      if (embedding !== undefined) {
        try {
          vectorFacts.push(...(await this.vectorFacts(embedding, now)));
        } catch {
          // A facts kNN failure must not drop the chunk list.
        }
        if (isAborted(signal)) {
          return [];
        }
        try {
          vectorChunks = await this.vectorChunks(embedding, forgotten, omit);
        } catch {
          vectorChunks = [];
        }
      }
    }
    const chunkHits = collapseChunkHits(vectorChunks, forgotten, (turnId) =>
      this.turnBody(turnId),
    );
    for (const memory of [...vectorFacts, ...chunkHits]) {
      if (omit.has(memory.id)) {
        continue;
      }
      remember(byId, memory);
    }
    const bm25Weight = vectorUp
      ? this.weights.bm25
      : Math.max(this.weights.bm25, 1);
    const fused = fuseRrf([
      { weight: bm25Weight, ids: facts.map((memory) => memory.id) },
      { weight: bm25Weight, ids: turns.map((memory) => memory.id) },
      { weight: bm25Weight, ids: summaries.map((memory) => memory.id) },
      {
        weight: vectorUp ? this.weights.vector : 0,
        ids: vectorFacts.map((memory) => memory.id),
      },
      {
        weight: vectorUp ? this.weights.vector : 0,
        ids: chunkHits.map((memory) => memory.id),
      },
    ]).slice(0, this.pool);
    const candidates: Memory[] = [];
    for (const row of fused) {
      const memory = byId.get(row.id);
      if (memory !== undefined && !omit.has(memory.id)) {
        candidates.push(memory);
      }
    }
    if (isAborted(signal)) {
      return [];
    }
    let ranked = candidates.slice(0, this.limit);
    if (this.rerank !== undefined) {
      try {
        ranked = (await this.rerank(query, candidates, signal)).filter(
          (memory) => !omit.has(memory.id),
        );
      } catch {
        ranked = candidates.slice(0, this.limit);
      }
    }
    if (isAborted(signal)) {
      return [];
    }
    return dedupeText(ranked).slice(0, this.limit);
  };

  private bm25Facts(match: string, now: number): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.text, f.superseded_by, f.valid_until, f.created_at
         FROM facts_fts
         JOIN facts f ON f.rowid = facts_fts.rowid
         WHERE facts_fts MATCH ?
           AND f.superseded_by IS NULL
           AND (f.valid_until IS NULL OR f.valid_until > ?)
         ORDER BY bm25(facts_fts), f.created_at, f.id
         LIMIT ?`,
      )
      .all(match, now, this.pool) as FactRow[];
    return rows.map((row) =>
      memoryFrom(row.id, row.text, "fact", row.created_at),
    );
  }

  private bm25Turns(
    match: string,
    forgotten: ReadonlySet<string>,
    omit: ReadonlySet<string>,
    query: string,
  ): Memory[] {
    const hidden = [...forgotten, ...omit];
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.content AS text, t.created_at AS created_at
         FROM turns_fts
         JOIN turns t ON t.rowid = turns_fts.rowid
         WHERE turns_fts MATCH ?
           ${
             hidden.length > 0
               ? "AND t.id NOT IN (SELECT value FROM json_each(?))"
               : ""
           }
         ORDER BY bm25(turns_fts), t.created_at, t.id
         LIMIT ?`,
      )
      .all(
        ...(hidden.length > 0
          ? [match, JSON.stringify(hidden), this.pool]
          : [match, this.pool]),
      ) as Array<{ id: string; text: string; created_at: number }>;
    return rows.map((row) =>
      memoryFrom(
        row.id,
        row.text,
        "turn",
        row.created_at,
        matchSpan(row.text, query),
      ),
    );
  }

  /**
   * Session summaries are lexical candidates when every query token of
   * length 4 or more occurs in the summary. A summary whose session has
   * a forgotten turn is dropped before the pool limit.
   */
  private bm25Summaries(
    query: string,
    forgotten: ReadonlySet<string>,
  ): Memory[] {
    const tokens = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 4);
    if (tokens.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        "SELECT id, summary, started_at FROM sessions WHERE summary IS NOT NULL",
      )
      .all() as Array<{ id: string; summary: string; started_at: number }>;
    const out: Memory[] = [];
    for (const row of rows) {
      const hay = row.summary.toLowerCase();
      const matches = tokens.every((token) =>
        hay.includes(token.toLowerCase()),
      );
      if (!matches || sessionHasForgottenTurn(this.db, row.id, forgotten)) {
        continue;
      }
      out.push(
        memoryFrom(
          `summary:${row.id}`,
          row.summary,
          "chunk",
          row.started_at,
          matchSpan(row.summary, query),
        ),
      );
      if (out.length === this.pool) {
        break;
      }
    }
    return out;
  }

  private async vectorFacts(
    embedding: Float32Array,
    now: number,
  ): Promise<Memory[]> {
    const hits = await this.knnUntil(embedding, "vec_facts", (id) => {
      const row = this.db
        .prepare(
          `SELECT id, text, superseded_by, valid_until, created_at
           FROM facts WHERE id = ?`,
        )
        .get(id) as FactRow | undefined;
      if (row === undefined || !liveFact(row, now)) {
        return null;
      }
      return memoryFrom(row.id, row.text, "fact", row.created_at);
    });
    return hits;
  }

  private async vectorChunks(
    embedding: Float32Array,
    forgotten: ReadonlySet<string>,
    omit: ReadonlySet<string>,
  ): Promise<Memory[]> {
    return this.knnUntil(embedding, "vec_chunks", (id) => {
      const row = this.db
        .prepare("SELECT chunk_id, text FROM chunks WHERE chunk_id = ?")
        .get(id) as { chunk_id: string; text: string } | undefined;
      if (row === undefined || row.text.trim() === "") {
        return null;
      }
      const turnId = turnIdFromChunkId(row.chunk_id);
      if (turnId !== null && (omit.has(turnId) || forgotten.has(turnId))) {
        return null;
      }
      if (chunkDerivedFromForgotten(this.db, id, forgotten)) {
        return null;
      }
      return memoryFrom(row.chunk_id, row.text, "chunk");
    });
  }

  private turnBody(turnId: string): { text: string; createdAt: number } | null {
    const row = this.db
      .prepare("SELECT content, created_at FROM turns WHERE id = ?")
      .get(turnId) as { content: string; created_at: number } | undefined;
    if (row === undefined) {
      return null;
    }
    return { text: row.content, createdAt: row.created_at };
  }

  /**
   * Ask kNN for more rows until `pool` live hits remain or the table is exhausted.
   * Dead facts are skipped before they count toward the pool.
   * `k` never exceeds {@link KNN_MAX_K}. sqlite-vec throws above that,
   * and that throw used to discard both vector lists.
   */
  private async knnUntil(
    embedding: Float32Array,
    table: "vec_facts" | "vec_chunks",
    accept: (id: string) => Memory | null,
  ): Promise<Memory[]> {
    let ask = Math.min(Math.max(this.pool, 1), KNN_MAX_K);
    let rows = await this.vectors.knn(table, embedding, ask);
    let live = accepted(rows, accept);
    while (live.length < this.pool && rows.length === ask && ask < KNN_MAX_K) {
      const next = Math.min(ask * 2, KNN_MAX_K);
      if (next === ask) {
        break;
      }
      ask = next;
      rows = await this.vectors.knn(table, embedding, ask);
      live = accepted(rows, accept);
    }
    return live.slice(0, this.pool);
  }
}

function accepted(
  rows: ReadonlyArray<{ id: string }>,
  accept: (id: string) => Memory | null,
): Memory[] {
  return rows
    .map((hit) => accept(hit.id))
    .filter((memory): memory is Memory => memory !== null);
}

/**
 * Wait for `work`, or reject when `signal` aborts.
 * The original promise always gets a handler so a late rejection
 * does not escape.
 */
function embedWithSignal(
  work: Promise<Float32Array>,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((outcome) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        return;
      }
      if (outcome.ok) {
        resolve(outcome.value);
        return;
      }
      reject(outcome.error);
    });
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Chunk ids from the indexer are `${turnId}#n`. BM25 returns `turnId`.
 * Map the chunk back to that turn before fusion so both legs add.
 * The earlier row is the better rank. A forgotten turn id is dropped.
 * Other chunk ids stay as they are.
 */
export function turnIdFromChunkId(chunkId: string): string | null {
  const match = /^(.*)#(\d+)$/.exec(chunkId);
  const turnId = match?.[1];
  if (turnId === undefined || turnId.length === 0) {
    return null;
  }
  return turnId;
}

export function collapseChunkHits(
  memories: readonly Memory[],
  forgotten: ReadonlySet<string> = new Set(),
  turnOf: (turnId: string) => { text: string; createdAt: number } | null = () =>
    null,
): Memory[] {
  const out: Memory[] = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    const turnId = turnIdFromChunkId(memory.id);
    const id = turnId ?? memory.id;
    if (forgotten.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (turnId === null) {
      out.push(memory);
      continue;
    }
    const turn = turnOf(turnId);
    const chunk = memory.text;
    const text = turn !== null && turn.text.length > 0 ? turn.text : chunk;
    out.push({
      id: turnId,
      text,
      source: "turn",
      createdAt: turn?.createdAt ?? memory.createdAt,
      matchText: chunk,
    });
  }
  return out;
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

/**
 * Ids from `store.forgottenTurnIds()` when that method exists.
 * Any other store, including `SqliteMemoryStore` before #18, yields
 * an empty set. A throw or a non-array result also yields an empty set
 * so a missing contract does not fail the chat.
 */
export function readForgottenTurnIds(store: unknown): ReadonlySet<string> {
  if (typeof store !== "object" || store === null) {
    return new Set();
  }
  if (!("forgottenTurnIds" in store)) {
    return new Set();
  }
  const method = store.forgottenTurnIds;
  if (typeof method !== "function") {
    return new Set();
  }
  let value: unknown;
  try {
    value = method.call(store);
  } catch {
    return new Set();
  }
  if (!Array.isArray(value)) {
    return new Set();
  }
  const ids = value.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return new Set(ids);
}

interface ChunkLink {
  chunk_id: string;
  session_id: string | null;
  first_turn: string | null;
  last_turn: string | null;
  text: string | null;
}

/**
 * A chunk is derived from a forgotten turn when any of these hold:
 * `embed_index.id` is the chunk and `source = 'turn'` and `source_id`
 * is forgotten; `chunks.first_turn` or `chunks.last_turn` is forgotten;
 * a `turns` row in `chunks.session_id` has `created_at` between those
 * two endpoints (inclusive).
 * A summary chunk has null endpoints, or its text equals
 * `sessions.summary` or `journal.entry` for that `session_id`.
 * That summary is derived from a forgotten turn when any
 * `turns.session_id` id is in the forgotten set.
 */
export function chunkDerivedFromForgotten(
  db: Database.Database,
  chunkId: string,
  forgotten: ReadonlySet<string>,
): boolean {
  if (forgotten.size === 0) {
    return false;
  }
  const indexed = db
    .prepare(
      `SELECT source_id FROM embed_index
       WHERE id = ? AND source = 'turn'`,
    )
    .get(chunkId) as { source_id: string } | undefined;
  if (indexed !== undefined && forgotten.has(indexed.source_id)) {
    return true;
  }
  const row = db
    .prepare(
      `SELECT chunk_id, session_id, first_turn, last_turn, text
       FROM chunks WHERE chunk_id = ?`,
    )
    .get(chunkId) as ChunkLink | undefined;
  if (row === undefined) {
    return false;
  }
  if (row.first_turn !== null && forgotten.has(row.first_turn)) {
    return true;
  }
  if (row.last_turn !== null && forgotten.has(row.last_turn)) {
    return true;
  }
  if (
    row.session_id !== null &&
    row.first_turn !== null &&
    row.last_turn !== null &&
    spanIncludesForgotten(
      db,
      row.session_id,
      row.first_turn,
      row.last_turn,
      forgotten,
    )
  ) {
    return true;
  }
  if (row.session_id !== null && summaryChunk(db, row)) {
    return sessionHasForgottenTurn(db, row.session_id, forgotten);
  }
  return false;
}

function spanIncludesForgotten(
  db: Database.Database,
  sessionId: string,
  firstTurn: string,
  lastTurn: string,
  forgotten: ReadonlySet<string>,
): boolean {
  const rows = db
    .prepare(
      `SELECT id FROM turns
       WHERE session_id = ?
         AND created_at BETWEEN (
           SELECT MIN(created_at) FROM turns WHERE id IN (?, ?)
         ) AND (
           SELECT MAX(created_at) FROM turns WHERE id IN (?, ?)
         )`,
    )
    .all(sessionId, firstTurn, lastTurn, firstTurn, lastTurn) as Array<{
    id: string;
  }>;
  return rows.some((row) => forgotten.has(row.id));
}

function summaryChunk(db: Database.Database, row: ChunkLink): boolean {
  const noEnds =
    (row.first_turn === null || row.first_turn === "") &&
    (row.last_turn === null || row.last_turn === "");
  if (noEnds) {
    return true;
  }
  if (row.session_id === null || row.text === null) {
    return false;
  }
  const summary = db
    .prepare("SELECT summary FROM sessions WHERE id = ?")
    .get(row.session_id) as { summary: string | null } | undefined;
  if (summary?.summary != null && summary.summary === row.text) {
    return true;
  }
  const journal = db
    .prepare(
      "SELECT id FROM journal WHERE session_id = ? AND entry = ? LIMIT 1",
    )
    .get(row.session_id, row.text) as { id: string } | undefined;
  return journal !== undefined;
}

function sessionHasForgottenTurn(
  db: Database.Database,
  sessionId: string,
  forgotten: ReadonlySet<string>,
): boolean {
  if (forgotten.size === 0) {
    return false;
  }
  const row = db
    .prepare(
      `SELECT id FROM turns
       WHERE session_id = ?
         AND id IN (SELECT value FROM json_each(?))
       LIMIT 1`,
    )
    .get(sessionId, JSON.stringify([...forgotten])) as
    | { id: string }
    | undefined;
  return row !== undefined;
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

function memoryFrom(
  id: string,
  text: string,
  source: MemorySource,
  createdAt?: number,
  matchText?: string,
): Memory {
  const memory: Memory = { id, text, source };
  if (createdAt !== undefined) {
    memory.createdAt = createdAt;
  }
  if (matchText !== undefined && matchText.length > 0 && matchText !== text) {
    memory.matchText = matchText;
  }
  return memory;
}

function remember(byId: Map<string, Memory>, memory: Memory): void {
  const existing = byId.get(memory.id);
  if (existing === undefined) {
    byId.set(memory.id, { ...memory });
    return;
  }
  if (
    memory.matchText !== undefined &&
    (existing.matchText === undefined ||
      memory.matchText.length > existing.matchText.length)
  ) {
    existing.matchText = memory.matchText;
  }
  if (memory.text.length > existing.text.length) {
    existing.text = memory.text;
  }
  if (existing.createdAt === undefined && memory.createdAt !== undefined) {
    existing.createdAt = memory.createdAt;
  }
}

const MATCH_STOPWORDS = new Set(
  `a an the and or but if of to in on for at by with from as is it its be am
   are was were do does did my me we our you your he she they them their this
   that these those what who how when where why not no so than then into about
   just can will would could should have has had`
    .split(/\s+/)
    .filter((word) => word.length > 0),
);

/**
 * Whole word from `text` for the longest useful query token.
 * Stopwords and tokens under 3 characters are skipped, so "is" does not
 * match inside "This". Comparison is case-insensitive on the original
 * word, so "İ" does not shift the slice.
 */
export function matchSpan(text: string, query: string): string | undefined {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((token) => {
    if (token.length < 3) {
      return false;
    }
    return !MATCH_STOPWORDS.has(token.toLocaleLowerCase("en"));
  });
  if (tokens.length === 0) {
    return undefined;
  }
  let best: { at: number; length: number; rank: number } | null = null;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const at = match.index;
    if (word === undefined || at === undefined) {
      continue;
    }
    for (const token of tokens) {
      if (word.localeCompare(token, "en", { sensitivity: "base" }) !== 0) {
        continue;
      }
      const rank = token.length;
      if (
        best === null ||
        rank > best.rank ||
        (rank === best.rank && at < best.at)
      ) {
        best = { at, length: word.length, rank };
      }
    }
  }
  if (best === null) {
    return undefined;
  }
  return text.slice(best.at, best.at + best.length);
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
