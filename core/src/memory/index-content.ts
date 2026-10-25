import type Database from "better-sqlite3";
import { chunkText, estimateTokens } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import { EMBED_MODEL_ID, prefixDocument } from "./http-embedder.ts";
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
 * Embed stored turns and facts that this model has not indexed yet.
 * Turns are split into chunks of at most 512 estimated tokens and written
 * to `chunks` and `vec_chunks`. A fact is one `vec_facts` row, the first
 * chunk when the text is longer than that cap.
 * Document text is prefixed with `search_document: ` before `embed`.
 * The raw chunk text is what retrieval shows.
 * Vectors are written before `embed_index`. A crash between the two
 * retries the turn. A down embedder writes nothing.
 */
export class ContentIndexer {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;
  private readonly vectors: VectorIndex;
  private readonly now: () => number;
  private readonly model: string;
  private readonly available: () => Promise<boolean>;

  constructor(options: ContentIndexerOptions) {
    this.db = options.db;
    this.embedder = options.embedder;
    this.vectors = options.vectors;
    this.now = options.now ?? (() => Date.now());
    this.model = options.model ?? EMBED_MODEL_ID;
    this.available = options.available ?? (async () => true);
  }

  async indexPending(): Promise<IndexStats> {
    let up = false;
    try {
      up = await this.available();
    } catch {
      up = false;
    }
    if (!up) {
      return { turns: 0, facts: 0, chunks: 0, skipped: true };
    }
    try {
      const planned = planTurnChunks(this.pendingTurns());
      const facts = planFacts(this.pendingFacts());
      const inputs = [
        ...planned.map((chunk) => prefixDocument(chunk.text)),
        ...facts.map((fact) => prefixDocument(fact.text)),
      ];
      const vectors = await embedAll(this.embedder, inputs);
      if (vectors.length !== inputs.length) {
        throw new Error(
          `embedder returned ${vectors.length} of ${inputs.length}`,
        );
      }
      await this.writeTurns(planned, vectors.slice(0, planned.length));
      await this.writeFacts(facts, vectors.slice(planned.length));
      return {
        turns: new Set(planned.map((chunk) => chunk.turnId)).size,
        facts: facts.length,
        chunks: planned.length,
        skipped: false,
      };
    } catch {
      return { turns: 0, facts: 0, chunks: 0, skipped: true };
    }
  }

  private pendingTurns(): PendingTurn[] {
    return this.db
      .prepare(
        `SELECT id, session_id, content FROM turns t
         WHERE NOT EXISTS (
           SELECT 1 FROM embed_index e
           WHERE e.source = 'turn' AND e.source_id = t.id AND e.model = ?
         )
         ORDER BY created_at, id`,
      )
      .all(this.model) as PendingTurn[];
  }

  private pendingFacts(): PendingFact[] {
    return this.db
      .prepare(
        `SELECT id, text FROM facts f
         WHERE NOT EXISTS (
           SELECT 1 FROM embed_index e
           WHERE e.source = 'fact' AND e.source_id = f.id AND e.model = ?
         )
         ORDER BY created_at, id`,
      )
      .all(this.model) as PendingFact[];
  }

  private async writeTurns(
    planned: PlannedChunk[],
    vectors: Float32Array[],
  ): Promise<void> {
    const turnIds = [...new Set(planned.map((chunk) => chunk.turnId))];
    for (const turnId of turnIds) {
      await this.vectors.delete(this.chunkIds(turnId));
    }
    for (let index = 0; index < planned.length; index += 1) {
      const chunk = planned[index];
      const vector = vectors[index];
      if (chunk === undefined || vector === undefined) {
        throw new Error("chunk vector missing");
      }
      await this.vectors.upsert("vec_chunks", chunk.id, vector);
    }
    const now = this.now();
    const write = this.db.transaction(() => {
      for (const turnId of turnIds) {
        this.db
          .prepare(
            "DELETE FROM embed_index WHERE source = 'turn' AND source_id = ?",
          )
          .run(turnId);
        this.db.prepare("DELETE FROM chunks WHERE first_turn = ?").run(turnId);
      }
      for (const chunk of planned) {
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

  private async writeFacts(
    facts: PlannedFact[],
    vectors: Float32Array[],
  ): Promise<void> {
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index];
      const vector = vectors[index];
      if (fact === undefined || vector === undefined) {
        throw new Error("fact vector missing");
      }
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

  private chunkIds(turnId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM embed_index WHERE source = 'turn' AND source_id = ?",
      )
      .all(turnId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }
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

function hasEmbedMany(embedder: Embedder): embedder is Embedder & {
  embedMany(texts: readonly string[]): Promise<Float32Array[]>;
} {
  if (!("embedMany" in embedder)) {
    return false;
  }
  return typeof embedder.embedMany === "function";
}
