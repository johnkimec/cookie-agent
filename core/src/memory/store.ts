import type { SessionRecord, TurnRecord } from "./types.ts";

/**
 * Optional filter for {@link MemoryStore.listSessions}.
 * `needsReflect: true` is a session that has turns and no summary yet.
 */
export interface ListSessionsQuery {
  needsReflect?: boolean;
}

/**
 * Open cookie.db, append sessions and turns, and read recent turns.
 * Derived tables are a separate interface. `listSessions` is read-only
 * so consolidation can see sessions from earlier runs.
 */
export interface MemoryStore {
  appendSession(session: SessionRecord): void;
  appendTurn(turn: TurnRecord): void;
  recentTurns(sessionId: string, limit: number): TurnRecord[];
  listSessions(query?: ListSessionsQuery): SessionRecord[];
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly turns: TurnRecord[] = [];

  appendSession(session: SessionRecord): void {
    if (this.sessions.has(session.id)) {
      throw new Error(`session already exists: ${session.id}`);
    }
    this.sessions.set(session.id, { ...session });
  }

  appendTurn(turn: TurnRecord): void {
    if (!this.sessions.has(turn.sessionId)) {
      throw new Error(`unknown session: ${turn.sessionId}`);
    }
    if (this.turns.some((row) => row.id === turn.id)) {
      throw new Error(`turn already exists: ${turn.id}`);
    }
    this.turns.push({ ...turn });
  }

  recentTurns(sessionId: string, limit: number): TurnRecord[] {
    const rows = this.turns
      .filter((row) => row.sessionId === sessionId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    if (limit <= 0) {
      return [];
    }
    return rows.slice(Math.max(0, rows.length - limit)).map((row) => ({
      ...row,
    }));
  }

  listSessions(query?: ListSessionsQuery): SessionRecord[] {
    const rows = [...this.sessions.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    );
    return rows
      .filter((session) => matchesReflect(session, this.turns, query))
      .map((session) => ({ ...session }));
  }
}

function matchesReflect(
  session: SessionRecord,
  turns: readonly TurnRecord[],
  query: ListSessionsQuery | undefined,
): boolean {
  if (query?.needsReflect === undefined) {
    return true;
  }
  const hasTurns = turns.some((turn) => turn.sessionId === session.id);
  const needs = session.summary === null && hasTurns;
  return query.needsReflect ? needs : session.summary !== null;
}
