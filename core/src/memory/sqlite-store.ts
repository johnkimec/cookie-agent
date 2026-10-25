import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ChunkRecord,
  type DerivedMemoryStore,
  FACT_KINDS,
  type FactKind,
  type FactRecord,
  type JournalRecord,
  type ProfileRecord,
} from "./derived.ts";
import { openMemoryDatabase } from "./migrate.ts";
import type { ListSessionsQuery, MemoryStore } from "./store.ts";
import type {
  SessionRecord,
  SessionSurface,
  TurnRecord,
  TurnRole,
} from "./types.ts";

const SURFACES = new Set<SessionSurface>([
  "popup",
  "menubar",
  "checkin",
  "widget",
]);

const ROLES = new Set<TurnRole>(["user", "assistant", "tool"]);

const APPEND_ONLY_SQL = `
CREATE TRIGGER IF NOT EXISTS turns_append_only_update
BEFORE UPDATE ON turns
BEGIN
  SELECT RAISE(ABORT, 'turns are append-only');
END;

CREATE TRIGGER IF NOT EXISTS turns_append_only_delete
BEFORE DELETE ON turns
BEGIN
  SELECT RAISE(ABORT, 'turns are append-only');
END;
`;

interface SessionRow {
  id: string;
  surface: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
}

interface TurnRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tainted: number;
  model: string | null;
  egress: number;
  escalated_from: string | null;
  tokens_in: number | null;
  tokens_cached: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: number;
}

export interface SqliteMemoryStoreOptions {
  /** Milliseconds. Tests pass a frozen clock. Production uses Date.now. */
  now?: () => number;
}

/**
 * better-sqlite3 store for migration 001.
 *
 * Turns are insert-only. FTS5 stays in step because migration 001's
 * insert trigger writes `turns_fts`. This class also installs triggers
 * that abort UPDATE and DELETE on `turns`.
 *
 * A session ends when `beginConversation` is called with a different id.
 * That id is `chat.send` `conversationId`. The app mints a new one for
 * a new chat and after the popup has been closed for 10 minutes. This
 * store does not time the window. `shutdown` does not end a session, so
 * a relaunch still has the turns.
 */
export class SqliteMemoryStore implements MemoryStore, DerivedMemoryStore {
  private readonly now: () => number;
  private readonly db: ReturnType<typeof openMemoryDatabase>;
  private closed = false;

  private constructor(
    db: ReturnType<typeof openMemoryDatabase>,
    now: () => number,
  ) {
    this.db = db;
    this.now = now;
  }

  static open(
    path: string,
    options: SqliteMemoryStoreOptions = {},
  ): SqliteMemoryStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = openMemoryDatabase(path);
    db.exec(APPEND_ONLY_SQL);
    return new SqliteMemoryStore(db, options.now ?? (() => Date.now()));
  }

  currentTime(): number {
    return this.now();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // A later open still reads the WAL.
    }
    this.db.close();
  }

  appendSession(session: SessionRecord): void {
    this.requireOpen();
    if (!SURFACES.has(session.surface)) {
      throw new Error(`unknown surface: ${session.surface}`);
    }
    if (this.readSession(session.id) !== null) {
      throw new Error(`session already exists: ${session.id}`);
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, surface, started_at, ended_at, summary)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.surface,
        session.startedAt,
        session.endedAt,
        session.summary,
      );
  }

  appendTurn(turn: TurnRecord): void {
    this.requireOpen();
    if (!ROLES.has(turn.role)) {
      throw new Error(`unknown turn role: ${turn.role}`);
    }
    const session = this.readSession(turn.sessionId);
    if (session === null) {
      throw new Error(`unknown session: ${turn.sessionId}`);
    }
    if (session.endedAt !== null) {
      throw new Error(`session ended: ${turn.sessionId}`);
    }
    const existing = this.db
      .prepare("SELECT id FROM turns WHERE id = ?")
      .get(turn.id) as { id: string } | undefined;
    if (existing !== undefined) {
      throw new Error(`turn already exists: ${turn.id}`);
    }
    this.db
      .prepare(
        `INSERT INTO turns (
          id, session_id, role, content, tainted, model, egress,
          escalated_from, tokens_in, tokens_cached, tokens_out,
          cost_usd, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.role,
        turn.content,
        turn.tainted ? 1 : 0,
        turn.model,
        turn.egress ? 1 : 0,
        turn.escalatedFrom,
        turn.tokensIn,
        turn.tokensCached,
        turn.tokensOut,
        turn.costUsd,
        turn.latencyMs,
        turn.createdAt,
      );
  }

  recentTurns(sessionId: string, limit: number): TurnRecord[] {
    this.requireOpen();
    if (limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM turns
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        ) ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, limit) as TurnRow[];
    return rows.map(turnFromRow);
  }

  session(id: string): SessionRecord | null {
    this.requireOpen();
    return this.readSession(id);
  }

  turnCount(sessionId: string): number {
    this.requireOpen();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  latestTurnAt(sessionId: string): number {
    this.requireOpen();
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(created_at), 0) AS n FROM turns WHERE session_id = ?",
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * `chat.send` `conversationId`. The same id continues the open session.
   * A different id ends every other open session first. An id whose
   * session already ended is returned as-is and is not reopened.
   */
  beginConversation(
    conversationId: string,
    surface: SessionSurface = "popup",
  ): SessionRecord {
    this.requireOpen();
    const existing = this.readSession(conversationId);
    if (existing !== null) {
      if (existing.endedAt === null) {
        this.endOtherOpenSessions(conversationId);
      }
      return this.readSession(conversationId) ?? existing;
    }
    this.endOtherOpenSessions(conversationId);
    this.appendSession({
      id: conversationId,
      surface,
      startedAt: this.now(),
      endedAt: null,
      summary: null,
    });
    const created = this.readSession(conversationId);
    if (created === null) {
      throw new Error(`session missing after insert: ${conversationId}`);
    }
    return created;
  }

  listSessions(query?: ListSessionsQuery): SessionRecord[] {
    this.requireOpen();
    const mode =
      query?.needsReflect === undefined
        ? "all"
        : query.needsReflect
          ? "yes"
          : "no";
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE (
           ? = 'all'
           OR (? = 'yes' AND summary IS NULL AND EXISTS (
             SELECT 1 FROM turns WHERE turns.session_id = sessions.id
           ))
           OR (? = 'no' AND summary IS NOT NULL)
         )
         ORDER BY started_at ASC, id ASC`,
      )
      .all(mode, mode, mode) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  insertFact(fact: FactRecord): void {
    this.requireOpen();
    requireKind(fact.kind);
    this.db
      .prepare(
        `INSERT INTO facts (
          id, text, kind, subject, confidence, sensitive, valid_until,
          superseded_by, source_turn, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.text,
        fact.kind,
        fact.subject,
        fact.confidence,
        bit(fact.sensitive),
        fact.validUntil,
        fact.supersededBy,
        fact.sourceTurn,
        fact.createdAt,
        fact.lastUsedAt,
      );
  }

  updateFact(fact: FactRecord): void {
    this.requireOpen();
    requireKind(fact.kind);
    const result = this.db
      .prepare(
        `UPDATE facts SET
          text = ?, kind = ?, subject = ?, confidence = ?, sensitive = ?,
          valid_until = ?, superseded_by = ?, source_turn = ?,
          created_at = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .run(
        fact.text,
        fact.kind,
        fact.subject,
        fact.confidence,
        bit(fact.sensitive),
        fact.validUntil,
        fact.supersededBy,
        fact.sourceTurn,
        fact.createdAt,
        fact.lastUsedAt,
        fact.id,
      );
    if (result.changes === 0) {
      throw new Error(`unknown fact: ${fact.id}`);
    }
  }

  factById(id: string): FactRecord | null {
    this.requireOpen();
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as
      | FactRow
      | undefined;
    return row === undefined ? null : factFromRow(row);
  }

  listFacts(): FactRecord[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT * FROM facts ORDER BY created_at ASC, id ASC")
      .all() as FactRow[];
    return rows.map(factFromRow);
  }

  upsertProfile(row: ProfileRecord): void {
    this.requireOpen();
    this.db
      .prepare(
        `INSERT INTO profile (
          key, value, pinned, shareable, source_turn, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          pinned = excluded.pinned,
          shareable = excluded.shareable,
          source_turn = excluded.source_turn,
          updated_at = excluded.updated_at`,
      )
      .run(
        row.key,
        row.value,
        bit(row.pinned),
        bit(row.shareable),
        row.sourceTurn,
        row.updatedAt,
      );
  }

  listProfile(): ProfileRecord[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT * FROM profile ORDER BY key ASC")
      .all() as ProfileRow[];
    return rows.map(profileFromRow);
  }

  replaceProfile(rows: readonly ProfileRecord[]): void {
    this.requireOpen();
    const insert = this.db.prepare(
      `INSERT INTO profile (
        key, value, pinned, shareable, source_turn, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      this.db.prepare("DELETE FROM profile").run();
      for (const row of rows) {
        insert.run(
          row.key,
          row.value,
          bit(row.pinned),
          bit(row.shareable),
          row.sourceTurn,
          row.updatedAt,
        );
      }
    });
    write();
  }

  insertJournal(row: JournalRecord): void {
    this.requireOpen();
    this.db
      .prepare(
        `INSERT INTO journal (id, day, entry, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.day, row.entry, row.sessionId, row.createdAt);
  }

  listJournal(sessionId?: string): JournalRecord[] {
    this.requireOpen();
    const rows =
      sessionId === undefined
        ? (this.db
            .prepare("SELECT * FROM journal ORDER BY created_at ASC, id ASC")
            .all() as JournalRow[])
        : (this.db
            .prepare(
              `SELECT * FROM journal
               WHERE session_id = ?
               ORDER BY created_at ASC, id ASC`,
            )
            .all(sessionId) as JournalRow[]);
    return rows.map(journalFromRow);
  }

  upsertChunk(row: ChunkRecord): void {
    this.requireOpen();
    this.db
      .prepare(
        `INSERT INTO chunks (chunk_id, session_id, first_turn, last_turn, text)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           session_id = excluded.session_id,
           first_turn = excluded.first_turn,
           last_turn = excluded.last_turn,
           text = excluded.text`,
      )
      .run(row.chunkId, row.sessionId, row.firstTurn, row.lastTurn, row.text);
  }

  listChunks(sessionId?: string): ChunkRecord[] {
    this.requireOpen();
    const rows =
      sessionId === undefined
        ? (this.db
            .prepare("SELECT * FROM chunks ORDER BY chunk_id ASC")
            .all() as ChunkRow[])
        : (this.db
            .prepare(
              `SELECT * FROM chunks
               WHERE session_id = ?
               ORDER BY chunk_id ASC`,
            )
            .all(sessionId) as ChunkRow[]);
    return rows.map(chunkFromRow);
  }

  deleteChunk(chunkId: string): void {
    this.requireOpen();
    this.db.prepare("DELETE FROM chunks WHERE chunk_id = ?").run(chunkId);
  }

  deleteChunks(sessionId: string): void {
    this.requireOpen();
    this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
  }

  deleteFact(id: string): void {
    this.requireOpen();
    const remove = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE facts SET superseded_by = NULL WHERE superseded_by = ?",
        )
        .run(id);
      const result = this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
      if (result.changes === 0) {
        throw new Error(`unknown fact: ${id}`);
      }
    });
    remove();
  }

  deleteJournal(sessionId: string): void {
    this.requireOpen();
    this.db.prepare("DELETE FROM journal WHERE session_id = ?").run(sessionId);
  }

  forgetTurn(
    turnId: string,
    forgottenAt: string,
    factIds: readonly string[],
  ): void {
    this.requireOpen();
    const existing = this.db
      .prepare("SELECT fact_ids FROM forgotten_turns WHERE turn_id = ?")
      .get(turnId) as { fact_ids: string } | undefined;
    const prior = parseFactIds(existing?.fact_ids);
    const merged = [...new Set([...prior, ...factIds])].sort();
    this.db
      .prepare(
        `INSERT INTO forgotten_turns (turn_id, forgotten_at, fact_ids)
         VALUES (?, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
           forgotten_at = excluded.forgotten_at,
           fact_ids = excluded.fact_ids`,
      )
      .run(turnId, forgottenAt, JSON.stringify(merged));
  }

  forgottenTurnIds(): string[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT turn_id FROM forgotten_turns ORDER BY turn_id ASC")
      .all() as Array<{ turn_id: string }>;
    return rows.map((row) => row.turn_id);
  }

  transaction(work: () => void): void {
    this.requireOpen();
    this.db.transaction(work)();
  }

  setSummary(sessionId: string, summary: string): void {
    this.requireOpen();
    const result = this.db
      .prepare("UPDATE sessions SET summary = ? WHERE id = ?")
      .run(summary, sessionId);
    if (result.changes === 0) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }

  clearSummary(sessionId: string): void {
    this.requireOpen();
    const result = this.db
      .prepare("UPDATE sessions SET summary = NULL WHERE id = ?")
      .run(sessionId);
    if (result.changes === 0) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }

  summary(sessionId: string): string | null {
    this.requireOpen();
    const row = this.db
      .prepare("SELECT summary FROM sessions WHERE id = ?")
      .get(sessionId) as { summary: string | null } | undefined;
    return row?.summary ?? null;
  }

  getMeta(key: string): string | null {
    this.requireOpen();
    const row = this.db
      .prepare("SELECT value FROM memory_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.requireOpen();
    this.db
      .prepare(
        `INSERT INTO memory_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  clearDerived(): void {
    this.requireOpen();
    const wipe = this.db.transaction(() => {
      this.db.prepare("UPDATE facts SET superseded_by = NULL").run();
      this.db.prepare("DELETE FROM facts").run();
      this.db.prepare("DELETE FROM profile").run();
      this.db.prepare("DELETE FROM journal").run();
      this.db.prepare("DELETE FROM chunks").run();
      this.db.prepare("UPDATE sessions SET summary = NULL").run();
    });
    wipe();
  }

  /** FTS5 over turn text. Migration 001's insert trigger keeps the index. */
  searchTurns(query: string, limit = 20): TurnRecord[] {
    this.requireOpen();
    const trimmed = query.trim();
    if (trimmed === "" || limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT t.* FROM turns_fts
         JOIN turns t ON t.rowid = turns_fts.rowid
         WHERE turns_fts MATCH ?
         ORDER BY bm25(turns_fts), t.created_at, t.id
         LIMIT ?`,
      )
      .all(ftsPhrase(trimmed), limit) as TurnRow[];
    return rows.map(turnFromRow);
  }

  private endOtherOpenSessions(exceptId: string): void {
    const now = this.now();
    const rows = this.db
      .prepare("SELECT id FROM sessions WHERE ended_at IS NULL AND id != ?")
      .all(exceptId) as Array<{ id: string }>;
    for (const row of rows) {
      this.endSession(row.id, now);
    }
  }

  private endSession(id: string, endedAt: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
      )
      .run(endedAt, id);
  }

  private readSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    return sessionFromRow(row);
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("memory store is closed");
    }
  }
}

function ftsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function sessionFromRow(row: SessionRow): SessionRecord {
  if (!SURFACES.has(row.surface as SessionSurface)) {
    throw new Error(`unknown surface: ${row.surface}`);
  }
  return {
    id: row.id,
    surface: row.surface as SessionSurface,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
  };
}

function turnFromRow(row: TurnRow): TurnRecord {
  if (!ROLES.has(row.role as TurnRole)) {
    throw new Error(`unknown turn role: ${row.role}`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as TurnRole,
    content: row.content,
    tainted: row.tainted !== 0,
    model: row.model,
    egress: row.egress !== 0,
    escalatedFrom: row.escalated_from,
    tokensIn: row.tokens_in,
    tokensCached: row.tokens_cached,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

interface FactRow {
  id: string;
  text: string;
  kind: string;
  subject: string | null;
  confidence: number;
  sensitive: number;
  valid_until: number | null;
  superseded_by: string | null;
  source_turn: string | null;
  created_at: number;
  last_used_at: number | null;
}

interface ProfileRow {
  key: string;
  value: string;
  pinned: number;
  shareable: number;
  source_turn: string | null;
  updated_at: number;
}

interface JournalRow {
  id: string;
  day: string;
  entry: string;
  session_id: string | null;
  created_at: number;
}

interface ChunkRow {
  chunk_id: string;
  session_id: string | null;
  first_turn: string | null;
  last_turn: string | null;
  text: string;
}

function parseFactIds(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function bit(value: boolean): number {
  return value ? 1 : 0;
}

function requireKind(kind: string): asserts kind is FactKind {
  if (!(FACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown fact kind: ${kind}`);
  }
}

function factFromRow(row: FactRow): FactRecord {
  requireKind(row.kind);
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    subject: row.subject,
    confidence: row.confidence,
    sensitive: row.sensitive !== 0,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    sourceTurn: row.source_turn,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function profileFromRow(row: ProfileRow): ProfileRecord {
  return {
    key: row.key,
    value: row.value,
    pinned: row.pinned !== 0,
    shareable: row.shareable !== 0,
    sourceTurn: row.source_turn,
    updatedAt: row.updated_at,
  };
}

function journalFromRow(row: JournalRow): JournalRecord {
  return {
    id: row.id,
    day: row.day,
    entry: row.entry,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

function chunkFromRow(row: ChunkRow): ChunkRecord {
  return {
    chunkId: row.chunk_id,
    sessionId: row.session_id,
    firstTurn: row.first_turn,
    lastTurn: row.last_turn,
    text: row.text,
  };
}
