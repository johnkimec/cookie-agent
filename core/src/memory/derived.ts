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

/** Subject on a fact that exists only so `superseded_by` has a target. */
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
  deleteChunks(sessionId: string): void;

  setSummary(sessionId: string, summary: string): void;
  summary(sessionId: string): string | null;

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /** Drops facts, profile, journal, chunks, and summaries. Keeps meta. */
  clearDerived(): void;
}

export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

export class InMemoryDerivedMemory implements DerivedMemoryStore {
  private readonly facts = new Map<string, FactRecord>();
  private readonly profile = new Map<string, ProfileRecord>();
  private readonly journal: JournalRecord[] = [];
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly summaries = new Map<string, string>();
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

  summary(sessionId: string): string | null {
    return this.summaries.get(sessionId) ?? null;
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
