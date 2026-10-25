import {
  type DerivedMemoryStore,
  type FactRecord,
  TOMBSTONE_SUBJECT,
} from "./derived.ts";
import type { Retrieve } from "./retrieve.ts";
import type { Memory, TurnRecord } from "./types.ts";

/** Cosine distance at or under this is the same fact, not a new one. */
export const DUPLICATE_DISTANCE = 0.08;

/** Consolidation merges facts at least this close. */
export const MERGE_DISTANCE = 0.12;

/** Forget-by-meaning uses this wider cutoff when the text does not match. */
export const FORGET_DISTANCE = 0.2;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{8,}\b/,
  /\b(?:api[_-]?key|password|passwd|secret|token|credential)s?\b\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/,
];

export function isSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A tainted turn's own words are screen or file content. Reflect drops
 * a long verbatim slice. An explicit remember is the user's ask, so the
 * tool does not use this check.
 */
export function isVerbatimScreen(
  text: string,
  turn: TurnRecord | undefined,
): boolean {
  if (turn === undefined || !turn.tainted) {
    return false;
  }
  if (text.length < 40) {
    return false;
  }
  return turn.content.includes(text);
}

export function isActiveFact(fact: FactRecord, now: number): boolean {
  if (fact.supersededBy !== null) {
    return false;
  }
  if (fact.subject === TOMBSTONE_SUBJECT) {
    return false;
  }
  if (fact.validUntil !== null && fact.validUntil <= now) {
    return false;
  }
  return true;
}

export function activeFacts(
  derived: DerivedMemoryStore,
  now: number,
): FactRecord[] {
  return derived.listFacts().filter((fact) => isActiveFact(fact, now));
}

/**
 * Retrieval itself is unchanged. Superseded and expired facts are
 * removed here so forget and consolidation take effect before a later
 * retriever learns the columns.
 */
export function withoutSuperseded(
  retrieve: Retrieve,
  derived: DerivedMemoryStore,
  now: () => number,
): Retrieve {
  return async (query) => {
    const hits = await retrieve(query);
    const active = new Set(activeFacts(derived, now()).map((fact) => fact.id));
    return hits.filter((hit) => keepHit(hit, active));
  };
}

function keepHit(hit: Memory, active: Set<string>): boolean {
  if (hit.source !== "fact") {
    return true;
  }
  return active.has(hit.id);
}
