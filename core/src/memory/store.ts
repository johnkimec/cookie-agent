import type { SessionRecord, TurnRecord } from "./types.ts";

/**
 * Open cookie.db, append sessions and turns, and read recent turns.
 * The SQLite store is Step 1A. This interface and the in-memory fake are
 * the Step 0 contract.
 */
export interface MemoryStore {
  appendSession(session: SessionRecord): void;
  appendTurn(turn: TurnRecord): void;
  recentTurns(sessionId: string, limit: number): TurnRecord[];
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
}
