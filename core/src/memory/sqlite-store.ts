import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openMemoryDatabase } from "./migrate.ts";
import type { MemoryStore } from "./store.ts";
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
export class SqliteMemoryStore implements MemoryStore {
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
