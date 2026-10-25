import type Database from "better-sqlite3";
import { chunkText, estimateTokens } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import {
  DEFAULT_EMBED_BATCH_SIZE,
  EMBED_MODEL_ID,
  prefixDocument,
} from "./http-embedder.ts";
import type { VectorIndex } from "./vectors.ts";

export interface IndexStats {
  turns: number;
  facts: number;
  chunks: number;
  /** Health said the embedder was down, or the embed request failed. */
  skipped: boolean;
}

export interface ContentIndexerOptions {
  db: Database.Database;
  embedder: Embedder;
  vectors: VectorIndex;
  now?: () => number;
  /** Stored on `embed_index.model`. Default is nomic-embed-text-v1.5. */
  model?: string;
  /**
   * When this returns false, nothing is written.
   * The stdio core passes the HTTP health check so a down server
   * does not fill vec tables with fake vectors.
   */
  available?: () => Promise<boolean>;
  /**
   * Turn ids to leave unindexed. The stdio core passes
   * `readForgottenTurnIds`. A missing callback skips nothing.
   * Rows in `forgotten_turns` are included when that table exists.
   */
  forgottenTurnIds?: () => Iterable<string>;
}

interface PendingTurn {
  id: string;
  session_id: string;
  content: string;
}

interface PendingFact {
  id: string;
  text: string;
}

interface PlannedChunk {
  id: string;
  sessionId: string;
  turnId: string;
  text: string;
  tokens: number;
}

interface PlannedFact {
  id: string;
  text: string;
  tokens: number;
}

/**
 * Turn chunks taken in one `indexPending` call.
 * A turn already started is finished, so a long turn can land a few past this.
 * Facts use the same cap, separately.
 */
export const INDEX_PASS_CHUNK_CAP = 64;

/**
 * Failed embed attempts for one turn before this process skips it.
 * The count is in memory, so a restart tries the turn again.
 * One failure stays under the limit and the next pass retries.
 */
export const INDEX_TURN_ATTEMPT_LIMIT = 3;

/**
 * Embed stored turns and facts that this model has not indexed yet.
 * Turns are split into chunks of at most 512 estimated tokens and written
 * to `chunks` and `vec_chunks`. A fact is one `vec_facts` row, the first
 * chunk when the text is longer than that cap.
 * Document text is prefixed with `search_document: ` before `embed`.
 * The raw chunk text is what retrieval shows.
 * Vectors are written before `embed_index`. A crash between the two
 * retries the turn. Each embed batch is its own commit.
 * A down embedder writes no new vectors. It still deletes vectors for
 * facts that were superseded or whose `valid_until` has passed.
 * A throw from that delete is logged and indexing continues.
 * A failed turn batch stops the rest of the turn pass and counts one
 * attempt for each turn in that batch. Facts still run afterward.
 * After `INDEX_TURN_ATTEMPT_LIMIT` attempts the turn is skipped so a
 * later turn can index. Turns named by `forgottenTurnIds`, or stored in
 * `forgotten_turns` when that table exists, are not embedded.
 */
export class ContentIndexer {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;
  private readonly vectors: VectorIndex;
  private readonly now: () => number;
  private readonly model: string;
  private readonly available: () => Promise<boolean>;
  private readonly forgottenTurnIds: (() => Iterable<string>) | null;
  private readonly turnAttempts = new Map<string, number>();

  constructor(options: ContentIndexerOptions) {
    this.db = options.db;
    this.embedder = options.embedder;
    this.vectors = options.vectors;
    this.now = options.now ?? (() => Date.now());
    this.model = options.model ?? EMBED_MODEL_ID;
    this.available = options.available ?? (async () => true);
    this.forgottenTurnIds = options.forgottenTurnIds ?? null;
  }

  async indexPending(): Promise<IndexStats> {
    const stats: IndexStats = {
      turns: 0,
      facts: 0,
      chunks: 0,
      skipped: false,
    };
    try {
      await this.deleteDeadFactVectors();
    } catch (error) {
      process.stderr.write(
        `cookie-core: dead-fact cleanup failed: ${errorText(error)}\n`,
      );
    }
    let up = false;
    try {
      up = await this.available();
    } catch {
      up = false;
    }
    if (!up) {
      return { ...stats, skipped: true };
    }
    const planned = takeChunkPass(this.pendingTurns(), INDEX_PASS_CHUNK_CAP);
    const started = new Set<string>();
    for (
      let offset = 0;
      offset < planned.length;
      offset += DEFAULT_EMBED_BATCH_SIZE
    ) {
      const batch = planned.slice(offset, offset + DEFAULT_EMBED_BATCH_SIZE);
      try {
        const vectors = await embedAll(
          this.embedder,
          batch.map((chunk) => prefixDocument(chunk.text)),
        );
        if (vectors.length !== batch.length) {
          throw new Error(
            `embedder returned ${vectors.length} of ${batch.length}`,
          );
        }
        await this.writeTurnBatch(batch, vectors, started);
        this.clearTurnAttempts(batch);
        stats.chunks += batch.length;
      } catch (error) {
        stats.skipped = true;
        if (!isTransientIndexError(error)) {
          this.noteTurnAttempts(batch);
        }
        process.stderr.write(
          `cookie-core: turn index failed: ${errorText(error)}\n`,
        );
        break;
      }
    }
    stats.turns = started.size;
    try {
      const facts = planFacts(this.pendingFacts()).slice(
        0,
        INDEX_PASS_CHUNK_CAP,
      );
      for (
        let offset = 0;
        offset < facts.length;
        offset += DEFAULT_EMBED_BATCH_SIZE
      ) {
        const batch = facts.slice(offset, offset + DEFAULT_EMBED_BATCH_SIZE);
        const vectors = await embedAll(
          this.embedder,
          batch.map((fact) => prefixDocument(fact.text)),
        );
        if (vectors.length !== batch.length) {
          throw new Error(
            `embedder returned ${vectors.length} of ${batch.length}`,
          );
        }
        await this.writeFactBatch(batch, vectors);
        stats.facts += batch.length;
      }
    } catch {
      stats.skipped = true;
    }
    return stats;
  }

  private pendingTurns(): PendingTurn[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.session_id, t.content,
          (
            SELECT count(*) FROM embed_index e
            WHERE e.source = 'turn' AND e.source_id = t.id AND e.model = ?
          ) AS indexed
         FROM turns t
         ORDER BY t.created_at, t.id`,
      )
      .all(this.model) as Array<PendingTurn & { indexed: number }>;
    const forgotten = this.forgottenIds();
    const pending: PendingTurn[] = [];
    for (const row of rows) {
      const expected = chunkText(row.content).length;
      if (expected === 0 || row.indexed === expected) {
        continue;
      }
      if (forgotten.has(row.id)) {
        continue;
      }
      const attempts = this.turnAttempts.get(row.id) ?? 0;
      if (attempts >= INDEX_TURN_ATTEMPT_LIMIT) {
        continue;
      }
      pending.push({
        id: row.id,
        session_id: row.session_id,
        content: row.content,
      });
    }
    return pending;
  }

  private pendingFacts(): PendingFact[] {
    const now = this.now();
    return this.db
      .prepare(
        `SELECT id, text FROM facts f
         WHERE f.superseded_by IS NULL
           AND (f.valid_until IS NULL OR f.valid_until > ?)
           AND NOT EXISTS (
             SELECT 1 FROM embed_index e
             WHERE e.source = 'fact' AND e.source_id = f.id AND e.model = ?
           )
         ORDER BY created_at, id`,
      )
      .all(now, this.model) as PendingFact[];
  }

  /**
   * Drop vec rows for facts that are superseded or expired.
   * `embed_index` goes second so a crash still finds the id next pass.
   */
  private async deleteDeadFactVectors(): Promise<void> {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT f.id FROM facts f
         WHERE (
           f.superseded_by IS NOT NULL
           OR (f.valid_until IS NOT NULL AND f.valid_until <= ?)
         )
         AND (
           EXISTS (
             SELECT 1 FROM embed_index e
             WHERE e.source = 'fact' AND e.source_id = f.id
           )
           OR EXISTS (SELECT 1 FROM vec_facts v WHERE v.fact_id = f.id)
         )`,
      )
      .all(now) as Array<{ id: string }>;
    if (rows.length === 0) {
      return;
    }
    const ids = rows.map((row) => row.id);
    await this.vectors.delete(ids);
    const drop = this.db.transaction(() => {
      for (const id of ids) {
        this.db
          .prepare(
            "DELETE FROM embed_index WHERE source = 'fact' AND source_id = ?",
          )
          .run(id);
      }
    });
    drop();
  }

  private async writeTurnBatch(
    batch: PlannedChunk[],
    vectors: Float32Array[],
    started: Set<string>,
  ): Promise<void> {
    const opening: string[] = [];
    for (const chunk of batch) {
      if (started.has(chunk.turnId)) {
        continue;
      }
      started.add(chunk.turnId);
      opening.push(chunk.turnId);
    }
    for (const turnId of opening) {
      await this.vectors.delete(this.chunkIds(turnId));
    }
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index];
      const vector = vectors[index];
      if (chunk === undefined || vector === undefined) {
        throw new Error("chunk vector missing");
      }
      await this.vectors.upsert("vec_chunks", chunk.id, vector);
    }
    const now = this.now();
    const write = this.db.transaction(() => {
      for (const turnId of opening) {
        this.db
          .prepare(
            "DELETE FROM embed_index WHERE source = 'turn' AND source_id = ?",
          )
          .run(turnId);
        this.db.prepare("DELETE FROM chunks WHERE first_turn = ?").run(turnId);
      }
      for (const chunk of batch) {
        this.db
          .prepare(
            `INSERT INTO chunks (
              chunk_id, session_id, first_turn, last_turn, text
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.id,
            chunk.sessionId,
            chunk.turnId,
            chunk.turnId,
            chunk.text,
          );
        this.db
          .prepare(
            `INSERT INTO embed_index (
              id, vec_table, source, source_id, model, tokens, created_at
            ) VALUES (?, 'vec_chunks', 'turn', ?, ?, ?, ?)`,
          )
          .run(chunk.id, chunk.turnId, this.model, chunk.tokens, now);
      }
    });
    write();
  }

  private async writeFactBatch(
    facts: PlannedFact[],
    vectors: Float32Array[],
  ): Promise<void> {
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index];
      const vector = vectors[index];
      if (fact === undefined || vector === undefined) {
        throw new Error("fact vector missing");
      }
      await this.vectors.delete([fact.id]);
      await this.vectors.upsert("vec_facts", fact.id, vector);
    }
    const now = this.now();
    const write = this.db.transaction(() => {
      for (const fact of facts) {
        this.db
          .prepare(
            "DELETE FROM embed_index WHERE source = 'fact' AND source_id = ?",
          )
          .run(fact.id);
        this.db
          .prepare(
            `INSERT INTO embed_index (
              id, vec_table, source, source_id, model, tokens, created_at
            ) VALUES (?, 'vec_facts', 'fact', ?, ?, ?, ?)`,
          )
          .run(fact.id, fact.id, this.model, fact.tokens, now);
      }
    });
    write();
  }

  private clearTurnAttempts(batch: readonly PlannedChunk[]): void {
    for (const chunk of batch) {
      this.turnAttempts.delete(chunk.turnId);
    }
  }

  private noteTurnAttempts(batch: readonly PlannedChunk[]): void {
    const seen = new Set<string>();
    for (const chunk of batch) {
      if (seen.has(chunk.turnId)) {
        continue;
      }
      seen.add(chunk.turnId);
      const next = (this.turnAttempts.get(chunk.turnId) ?? 0) + 1;
      this.turnAttempts.set(chunk.turnId, next);
    }
  }

  private forgottenIds(): Set<string> {
    const ids = new Set<string>();
    if (this.forgottenTurnIds !== null) {
      try {
        for (const id of this.forgottenTurnIds()) {
          if (typeof id === "string" && id.length > 0) {
            ids.add(id);
          }
        }
      } catch {
        // A bad callback must not skip the pass.
      }
    }
    for (const id of forgottenTurnIdsFromTable(this.db)) {
      ids.add(id);
    }
    return ids;
  }

  private chunkIds(turnId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM embed_index WHERE source = 'turn' AND source_id = ?",
      )
      .all(turnId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }
}

/**
 * Whole turns until the next one would pass `cap`.
 * The first turn is kept even when it is longer than `cap`.
 */
function takeChunkPass(
  turns: readonly PendingTurn[],
  cap: number,
): PlannedChunk[] {
  const planned: PlannedChunk[] = [];
  for (const turn of turns) {
    const chunks = planTurnChunks([turn]);
    if (chunks.length === 0) {
      continue;
    }
    if (planned.length > 0 && planned.length + chunks.length > cap) {
      break;
    }
    planned.push(...chunks);
    if (planned.length >= cap) {
      break;
    }
  }
  return planned;
}

function planTurnChunks(turns: readonly PendingTurn[]): PlannedChunk[] {
  const planned: PlannedChunk[] = [];
  for (const turn of turns) {
    const pieces = chunkText(turn.content);
    for (let index = 0; index < pieces.length; index += 1) {
      const text = pieces[index];
      if (text === undefined) {
        continue;
      }
      planned.push({
        id: `${turn.id}#${index}`,
        sessionId: turn.session_id,
        turnId: turn.id,
        text,
        tokens: estimateTokens(text),
      });
    }
  }
  return planned;
}

function planFacts(facts: readonly PendingFact[]): PlannedFact[] {
  const planned: PlannedFact[] = [];
  for (const fact of facts) {
    const text = chunkText(fact.text)[0];
    if (text === undefined) {
      continue;
    }
    planned.push({ id: fact.id, text, tokens: estimateTokens(text) });
  }
  return planned;
}

async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  if (hasEmbedMany(embedder)) {
    return embedder.embedMany(texts);
  }
  const out: Float32Array[] = [];
  for (const text of texts) {
    out.push(await embedder.embed(text));
  }
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "unknown error";
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Timeouts and connection failures are not a bad turn. */
function isTransientIndexError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current !== "object") {
      return false;
    }
    const record = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (record.name === "TimeoutError") {
      return true;
    }
    if (typeof record.code === "string" && TRANSIENT_CODES.has(record.code)) {
      return true;
    }
    if (
      typeof record.message === "string" &&
      /timeout|timed out|econnrefused|econnreset|embedder unreachable/i.test(
        record.message,
      )
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * Ids from `forgotten_turns` when that table exists.
 * #18 owns the table. `turn_id` wins; otherwise `id`.
 * A missing table, or a query error, yields nothing.
 */
function forgottenTurnIdsFromTable(db: Database.Database): string[] {
  let columns: Array<{ name: string }>;
  try {
    columns = db
      .prepare("SELECT name FROM pragma_table_info('forgotten_turns')")
      .all() as Array<{ name: string }>;
  } catch {
    return [];
  }
  if (columns.length === 0) {
    return [];
  }
  const names = new Set(columns.map((column) => column.name));
  let sql: string | null = null;
  if (names.has("turn_id")) {
    sql = "SELECT turn_id AS id FROM forgotten_turns";
  } else if (names.has("id")) {
    sql = "SELECT id FROM forgotten_turns";
  }
  if (sql === null) {
    return [];
  }
  try {
    const rows = db.prepare(sql).all() as Array<{ id: unknown }>;
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function hasEmbedMany(embedder: Embedder): embedder is Embedder & {
  embedMany(texts: readonly string[]): Promise<Float32Array[]>;
} {
  if (!("embedMany" in embedder)) {
    return false;
  }
  return typeof embedder.embedMany === "function";
}
