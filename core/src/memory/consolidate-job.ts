import {
  type ChunkRecord,
  type DerivedMemoryStore,
  type FactRecord,
  TOMBSTONE_SUBJECT,
} from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import { prefixDocument, prefixQuery } from "./http-embedder.ts";
import { activeFacts, isActiveFact, MERGE_DISTANCE } from "./policy.ts";
import { capProfile, PROFILE_TOKEN_CAP } from "./profile-cap.ts";
import { abortError } from "./slot.ts";
import { embedFact, tombstone } from "./tools.ts";
import type { TurnRecord } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

export const CHUNK_CHAR_BUDGET = 800;

/**
 * SQLite maintenance from the design doc.
 * TODO(M1 store): `PRAGMA optimize` and a dated backup belong on the
 * real store. The in-memory fake has nothing to compact.
 */
export interface StoreMaintenance {
  optimizeAndBackup(): Promise<void>;
}

export interface LocalConsolidatorOptions {
  derived: DerivedMemoryStore;
  embedder: Embedder;
  vectors: VectorIndex;
  sessionIds: () => readonly string[];
  readTurns: (sessionId: string) => TurnRecord[];
  now: () => number;
  timeZone: string;
  localDay: (epochMs: number, timeZone: string) => string;
  ids: () => string;
  maintenance?: StoreMaintenance;
  log?: (message: string) => void;
}

/**
 * Expire, merge, cap the profile, and re-chunk today's turns.
 * Does not call the chat model. The scheduler still holds the llama
 * slot so a chat can abort the job before it writes.
 *
 * TODO(M5): the AC-power check lives on the scheduler, not here.
 */
export class LocalConsolidator {
  private signal: AbortSignal = new AbortController().signal;
  private readonly options: LocalConsolidatorOptions;

  constructor(options: LocalConsolidatorOptions) {
    this.options = options;
  }

  bindSignal(signal: AbortSignal): void {
    this.signal = signal;
  }

  readonly consolidate = async (): Promise<void> => {
    const signal = this.signal;
    throwIfAborted(signal);
    await this.expire(signal);
    await yieldBatch();
    throwIfAborted(signal);
    await this.mergeDuplicates(signal);
    await yieldBatch();
    throwIfAborted(signal);
    capProfile(
      this.options.derived.listProfile(),
      PROFILE_TOKEN_CAP,
      this.options.log ?? (() => undefined),
    );
    await yieldBatch();
    throwIfAborted(signal);
    await this.rechunkToday(signal);
    throwIfAborted(signal);
    if (this.options.maintenance !== undefined) {
      await this.options.maintenance.optimizeAndBackup();
    }
  };

  private async expire(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    const due = this.options.derived
      .listFacts()
      .filter(
        (fact) =>
          isActiveFact(fact, now) === false &&
          fact.supersededBy === null &&
          fact.subject !== TOMBSTONE_SUBJECT &&
          fact.validUntil !== null &&
          fact.validUntil <= now,
      );
    for (const fact of due) {
      throwIfAborted(signal);
      const marker = tombstone(this.options.ids(), fact, now);
      marker.text = `Expired: ${fact.text}`;
      this.options.derived.insertFact(marker);
      this.options.derived.updateFact({ ...fact, supersededBy: marker.id });
    }
  }

  private async mergeDuplicates(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    const facts = activeFacts(this.options.derived, now);
    const dropped = new Set<string>();
    for (const fact of facts) {
      throwIfAborted(signal);
      if (dropped.has(fact.id)) {
        continue;
      }
      await embedFact(this.options, fact);
      const embedding = await this.options.embedder.embed(
        prefixQuery(fact.text),
      );
      const hits = await this.options.vectors.knn("vec_facts", embedding, 8);
      for (const hit of hits) {
        if (hit.id === fact.id || hit.distance > MERGE_DISTANCE) {
          continue;
        }
        const other = this.options.derived.factById(hit.id);
        if (
          other === null ||
          !isActiveFact(other, now) ||
          dropped.has(other.id)
        ) {
          continue;
        }
        const loser = pickLoser(fact, other);
        const winner = loser.id === fact.id ? other : fact;
        const marker = tombstone(this.options.ids(), loser, now);
        marker.text = `Merged into ${winner.id}: ${loser.text}`;
        this.options.derived.insertFact(marker);
        this.options.derived.updateFact({
          ...loser,
          supersededBy: marker.id,
        });
        dropped.add(loser.id);
        if (loser.id === fact.id) {
          break;
        }
      }
    }
  }

  private async rechunkToday(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    const today = this.options.localDay(now, this.options.timeZone);
    const forgotten = new Set(this.options.derived.forgottenTurnIds());
    for (const sessionId of this.options.sessionIds()) {
      throwIfAborted(signal);
      const todayTurns = this.options.readTurns(sessionId).filter((turn) => {
        if (forgotten.has(turn.id)) {
          return false;
        }
        return (
          this.options.localDay(turn.createdAt, this.options.timeZone) === today
        );
      });
      if (todayTurns.length === 0) {
        continue;
      }
      const todayIds = new Set(todayTurns.map((turn) => turn.id));
      const stale = this.options.derived
        .listChunks(sessionId)
        .filter(
          (chunk) =>
            (chunk.firstTurn !== null && todayIds.has(chunk.firstTurn)) ||
            (chunk.lastTurn !== null && todayIds.has(chunk.lastTurn)),
        );
      if (stale.length > 0) {
        await this.options.vectors.delete(stale.map((chunk) => chunk.chunkId));
        for (const chunk of stale) {
          this.options.derived.deleteChunk(chunk.chunkId);
        }
      }
      const chunks = chunkTurns(sessionId, todayTurns, CHUNK_CHAR_BUDGET, [
        sessionId,
        today,
      ]);
      for (const chunk of chunks) {
        throwIfAborted(signal);
        this.options.derived.upsertChunk(chunk);
        const embedding = await this.options.embedder.embed(
          prefixDocument(chunk.text),
        );
        await this.options.vectors.upsert(
          "vec_chunks",
          chunk.chunkId,
          embedding,
        );
      }
      await yieldBatch();
    }
  }
}

function yieldBatch(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function chunkTurns(
  sessionId: string,
  turns: readonly TurnRecord[],
  budget: number = CHUNK_CHAR_BUDGET,
  idParts: readonly string[] = [sessionId],
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  let batch: TurnRecord[] = [];
  let size = 0;
  const flush = (): void => {
    if (batch.length === 0) {
      return;
    }
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    chunks.push({
      chunkId: `chunk-${[...idParts, String(chunks.length)].join("-")}`,
      sessionId,
      firstTurn: first.id,
      lastTurn: last.id,
      text: batch.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
    });
    batch = [];
    size = 0;
  };
  for (const turn of turns) {
    const line = `${turn.role}: ${turn.content}`;
    if (batch.length > 0 && size + line.length + 1 > budget) {
      flush();
    }
    batch.push(turn);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

function pickLoser(left: FactRecord, right: FactRecord): FactRecord {
  if (left.confidence !== right.confidence) {
    return left.confidence < right.confidence ? left : right;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? left : right;
  }
  return left.id < right.id ? right : left;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}
