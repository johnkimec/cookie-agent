import { randomUUID } from "node:crypto";

/**
 * Derived memory: profile, journal, facts, chunks, and session summaries.
 *
 * Step 0's {@link MemoryStore} appends sessions and turns only. These
 * tables are the rebuildable layer from the design doc. This file is the
 * step 2E contract and its in-memory fake. The SQLite store should
 * implement the same interface; it does not live here.
 */

export const FACT_KINDS = [
  "preference",
  "person",
  "project",
  "event",
  "habit",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/**
 * Subject on a supersede marker (a correction, expiry, or merge).
 * Forget does not write one of these. It deletes the fact and records
 * the turn id in `forgotten_turns`.
 */
export const TOMBSTONE_SUBJECT = "memory:tombstone";

export type FactRecord = {
  id: string;
  text: string;
  kind: FactKind;
  subject: string | null;
  confidence: number;
  sensitive: boolean;
  validUntil: number | null;
  supersededBy: string | null;
  sourceTurn: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

export type ProfileRecord = {
  key: string;
  value: string;
  pinned: boolean;
  shareable: boolean;
  sourceTurn: string | null;
  updatedAt: number;
};

export type JournalRecord = {
  id: string;
  /** `YYYY-MM-DD` in the local time zone. */
  day: string;
  entry: string;
  sessionId: string | null;
  createdAt: number;
};

export type ChunkRecord = {
  chunkId: string;
  sessionId: string | null;
  firstTurn: string | null;
  lastTurn: string | null;
  text: string;
};

/**
 * Writes and reads for derived tables.
 * Callers copy records in and get copies out.
 */
export interface DerivedMemoryStore {
  insertFact(fact: FactRecord): void;
  updateFact(fact: FactRecord): void;
  factById(id: string): FactRecord | null;
  listFacts(): FactRecord[];

  upsertProfile(row: ProfileRecord): void;
  listProfile(): ProfileRecord[];
  replaceProfile(rows: readonly ProfileRecord[]): void;

  insertJournal(row: JournalRecord): void;
  listJournal(sessionId?: string): JournalRecord[];

  upsertChunk(row: ChunkRecord): void;
  listChunks(sessionId?: string): ChunkRecord[];
  deleteChunk(chunkId: string): void;
  deleteChunks(sessionId: string): void;

  setSummary(sessionId: string, summary: string): void;
  /** Sets `sessions.summary` back to null. */
  clearSummary(sessionId: string): void;
  summary(sessionId: string): string | null;

  deleteFact(id: string): void;
  deleteJournal(sessionId: string): void;

  /**
   * Remember that this turn must not be derived again.
   * `forgottenAt` is an ISO date. `factIds` are the removed fact ids.
   * No fact text is stored.
   */
  forgetTurn(
    turnId: string,
    forgottenAt: string,
    factIds: readonly string[],
  ): void;
  /** Turn ids forget recorded. Retrieval (step 2D) excludes these. */
  forgottenTurnIds(): string[];

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /**
   * Runs `work` as one commit. SQLite rolls it back on throw.
   * The in-memory fake runs it inline.
   */
  transaction(work: () => void): void;

  /**
   * Drops facts, profile, journal, chunks, and summaries.
   * Keeps meta and `forgotten_turns`, so rebuild cannot resurrect them.
   */
  clearDerived(): void;
}

export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** New id on every call. A restarted process must not reuse fact-1. */
export function randomIds(prefix: string): () => string {
  return () => `${prefix}-${randomUUID()}`;
}

export class InMemoryDerivedMemory implements DerivedMemoryStore {
  private readonly facts = new Map<string, FactRecord>();
  private readonly profile = new Map<string, ProfileRecord>();
  private readonly journal: JournalRecord[] = [];
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly summaries = new Map<string, string>();
  private readonly forgotten = new Map<
    string,
    { at: string; factIds: string[] }
  >();
  private readonly meta = new Map<string, string>();

  insertFact(fact: FactRecord): void {
    if (this.facts.has(fact.id)) {
      throw new Error(`fact already exists: ${fact.id}`);
    }
    this.facts.set(fact.id, cloneFact(fact));
  }

  updateFact(fact: FactRecord): void {
    if (!this.facts.has(fact.id)) {
      throw new Error(`unknown fact: ${fact.id}`);
    }
    this.facts.set(fact.id, cloneFact(fact));
  }

  factById(id: string): FactRecord | null {
    const fact = this.facts.get(id);
    return fact === undefined ? null : cloneFact(fact);
  }

  listFacts(): FactRecord[] {
    return [...this.facts.values()]
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      )
      .map(cloneFact);
  }

  upsertProfile(row: ProfileRecord): void {
    this.profile.set(row.key, cloneProfile(row));
  }

  listProfile(): ProfileRecord[] {
    return [...this.profile.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneProfile);
  }

  replaceProfile(rows: readonly ProfileRecord[]): void {
    this.profile.clear();
    for (const row of rows) {
      this.profile.set(row.key, cloneProfile(row));
    }
  }

  insertJournal(row: JournalRecord): void {
    if (this.journal.some((entry) => entry.id === row.id)) {
      throw new Error(`journal already exists: ${row.id}`);
    }
    this.journal.push(cloneJournal(row));
  }

  listJournal(sessionId?: string): JournalRecord[] {
    return this.journal
      .filter(
        (entry) => sessionId === undefined || entry.sessionId === sessionId,
      )
      .map(cloneJournal);
  }

  upsertChunk(row: ChunkRecord): void {
    this.chunks.set(row.chunkId, cloneChunk(row));
  }

  listChunks(sessionId?: string): ChunkRecord[] {
    return [...this.chunks.values()]
      .filter((row) => sessionId === undefined || row.sessionId === sessionId)
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
      .map(cloneChunk);
  }

  deleteChunk(chunkId: string): void {
    this.chunks.delete(chunkId);
  }

  deleteChunks(sessionId: string): void {
    for (const [id, row] of this.chunks) {
      if (row.sessionId === sessionId) {
        this.chunks.delete(id);
      }
    }
  }

  setSummary(sessionId: string, summary: string): void {
    this.summaries.set(sessionId, summary);
  }

  clearSummary(sessionId: string): void {
    this.summaries.delete(sessionId);
  }

  summary(sessionId: string): string | null {
    return this.summaries.get(sessionId) ?? null;
  }

  deleteFact(id: string): void {
    if (!this.facts.has(id)) {
      throw new Error(`unknown fact: ${id}`);
    }
    for (const fact of this.facts.values()) {
      if (fact.supersededBy === id) {
        fact.supersededBy = null;
      }
    }
    this.facts.delete(id);
  }

  deleteJournal(sessionId: string): void {
    for (let index = this.journal.length - 1; index >= 0; index -= 1) {
      if (this.journal[index]?.sessionId === sessionId) {
        this.journal.splice(index, 1);
      }
    }
  }

  forgetTurn(
    turnId: string,
    forgottenAt: string,
    factIds: readonly string[],
  ): void {
    const prior = this.forgotten.get(turnId);
    const merged = [...new Set([...(prior?.factIds ?? []), ...factIds])].sort();
    this.forgotten.set(turnId, { at: forgottenAt, factIds: merged });
  }

  forgottenTurnIds(): string[] {
    return [...this.forgotten.keys()].sort();
  }

  transaction(work: () => void): void {
    work();
  }

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  clearDerived(): void {
    this.facts.clear();
    this.profile.clear();
    this.journal.length = 0;
    this.chunks.clear();
    this.summaries.clear();
  }
}

function cloneFact(fact: FactRecord): FactRecord {
  return { ...fact };
}

function cloneProfile(row: ProfileRecord): ProfileRecord {
  return { ...row };
}

function cloneJournal(row: JournalRecord): JournalRecord {
  return { ...row };
}

function cloneChunk(row: ChunkRecord): ChunkRecord {
  return { ...row };
}
