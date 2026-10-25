import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  type ChunkRecord,
  type DerivedMemoryStore,
  FACT_KINDS,
  type FactKind,
  type FactRecord,
  type ProfileRecord,
  TOMBSTONE_SUBJECT,
} from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import { prefixDocument, prefixQuery } from "./http-embedder.ts";
import {
  activeFacts,
  FORGET_DISTANCE,
  isActiveFact,
  isSecret,
} from "./policy.ts";
import type { MemoryStore } from "./store.ts";
import type { VectorIndex } from "./vectors.ts";

export const MEMORY_REMEMBER_TOOL = "memory.remember";
export const MEMORY_FORGET_TOOL = "memory.forget";

/** Design doc: at most 8 tool steps on the local model. */
export const LOCAL_TOOL_STEP_LIMIT = 8;

export const MEMORY_SYSTEM_PROMPT =
  "You are Cookie, a local on-device assistant. Reply briefly. You can call memory.remember and memory.forget. You cannot browse or call a cloud model.";

const factKindSchema = z.enum(FACT_KINDS);

export type MemoryToolState = {
  sourceTurnId: string | null;
};

/** Text forget needs at least this many characters. */
export const MIN_FORGET_TEXT = 4;

export interface MemoryToolDeps {
  derived: DerivedMemoryStore;
  store: MemoryStore;
  embedder: Embedder;
  vectors: VectorIndex;
  state: MemoryToolState;
  now: () => number;
  ids: () => string;
  /** Ids only. Fact text must not be logged. */
  log?: (message: string) => void;
}

const rememberInput = z.object({
  text: z.string().min(1).describe("One atomic fact to store."),
  kind: factKindSchema.describe(
    "preference, person, project, event, or habit.",
  ),
  subject: z
    .string()
    .nullable()
    .optional()
    .describe("Entity key such as person:alex, or null."),
  sensitive: z
    .boolean()
    .optional()
    .describe("True for health, money, or other people. Stays on this Mac."),
  aboutJohn: z
    .boolean()
    .optional()
    .describe("True when the fact is about John. Those are pinned."),
  profileKey: z
    .string()
    .optional()
    .describe("Profile key when aboutJohn is true, such as school."),
  validUntil: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Unix milliseconds when the fact expires, or null."),
});

const forgetInput = z
  .object({
    factId: z.string().min(1).optional().describe("Fact id to forget."),
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Words that identify the fact, when the id is unknown."),
  })
  .refine((value) => value.factId !== undefined || value.text !== undefined, {
    message: "factId or text is required",
  });

type RememberInput = z.infer<typeof rememberInput>;
type ForgetInput = z.infer<typeof forgetInput>;

export function createMemoryTools(deps: MemoryToolDeps): ToolSet {
  return {
    [MEMORY_REMEMBER_TOOL]: tool({
      description:
        "Store one fact John explicitly asked to remember. Pin it on his profile when it is about him. Never store secrets or credentials.",
      inputSchema: rememberInput,
      execute: (input) => rememberFact(deps, input),
    }),
    [MEMORY_FORGET_TOOL]: tool({
      description:
        "Forget a fact John asked to drop. Deletes that fact, its profile row, and derived rows built from its turn. When no fact matches, an exact or unique turn or chunk match is forgotten the same way. Raw turns stay. An exact match is forgotten, and any other partial matches are returned as candidates. If several matches and none is exact, returns the candidates and deletes nothing.",
      inputSchema: forgetInput,
      execute: (input) => forgetFact(deps, input),
    }),
  };
}

async function rememberFact(
  deps: MemoryToolDeps,
  input: RememberInput,
): Promise<
  | {
      remembered: true;
      factId: string;
      pinned: boolean;
      sourceTurn: string | null;
    }
  | { remembered: false; reason: "secret" | "empty" }
> {
  const text = input.text.trim();
  if (text.length === 0) {
    return { remembered: false, reason: "empty" };
  }
  if (isSecret(text)) {
    return { remembered: false, reason: "secret" };
  }
  const now = deps.now();
  const factId = deps.ids();
  const aboutJohn = input.aboutJohn === true;
  const fact: FactRecord = {
    id: factId,
    text,
    kind: input.kind,
    subject: cleanSubject(input.subject),
    confidence: 1,
    sensitive: input.sensitive === true,
    validUntil: input.validUntil ?? null,
    supersededBy: null,
    sourceTurn: deps.state.sourceTurnId,
    createdAt: now,
    lastUsedAt: null,
  };
  deps.derived.insertFact(fact);
  await embedFact(deps, fact);
  if (aboutJohn) {
    const key = profileKeyFor(input.profileKey, fact);
    const row: ProfileRecord = {
      key,
      value: text,
      pinned: true,
      shareable: fact.sensitive !== true,
      sourceTurn: fact.sourceTurn,
      updatedAt: now,
    };
    deps.derived.upsertProfile(row);
  }
  return {
    remembered: true,
    factId,
    pinned: aboutJohn,
    sourceTurn: fact.sourceTurn,
  };
}

type ForgetCandidate = { id: string; text: string };

type ForgetMatch =
  | { kind: "facts"; facts: FactRecord[]; candidates: ForgetCandidate[] }
  | { kind: "ambiguous"; candidates: ForgetCandidate[] }
  | { kind: "too short" }
  | { kind: "none" };

async function forgetFact(
  deps: MemoryToolDeps,
  input: ForgetInput,
): Promise<
  | { forgotten: true; factIds: string[]; candidates?: ForgetCandidate[] }
  | { forgotten: false; reason: "not found" | "too short" }
  | {
      forgotten: false;
      reason: "ambiguous";
      candidates: ForgetCandidate[];
    }
> {
  const now = deps.now();
  const match = await factsToForget(deps, input, now);
  if (match.kind === "too short") {
    return { forgotten: false, reason: "too short" };
  }
  if (match.kind === "ambiguous") {
    return {
      forgotten: false,
      reason: "ambiguous",
      candidates: match.candidates,
    };
  }
  if (match.kind === "none") {
    if (input.text === undefined) {
      return { forgotten: false, reason: "not found" };
    }
    const fallback = locateTurnOrChunk(deps, input.text);
    if (fallback.kind === "ambiguous") {
      return {
        forgotten: false,
        reason: "ambiguous",
        candidates: fallback.candidates,
      };
    }
    if (fallback.kind === "none") {
      return { forgotten: false, reason: "not found" };
    }
    return commitForget(
      deps,
      [],
      fallback.keys,
      fallback.turnIds,
      now,
      fallback.candidates,
    );
  }
  const facts = match.facts;
  const keys = keyStrings(facts, input.text);
  return commitForget(
    deps,
    facts,
    keys,
    turnsToForget(deps, facts, keys),
    now,
    match.candidates,
  );
}

async function commitForget(
  deps: MemoryToolDeps,
  facts: readonly FactRecord[],
  keys: readonly string[],
  turnIds: Set<string>,
  now: number,
  candidates: ForgetCandidate[],
): Promise<
  | { forgotten: true; factIds: string[]; candidates?: ForgetCandidate[] }
  | { forgotten: false; reason: "not found" }
> {
  const texts = [
    ...facts.map((fact) => fact.text),
    ...(facts.length === 0 ? keys : []),
  ];
  const doomed = deps.derived
    .listFacts()
    .filter((fact) => copyOfForgotten(fact, facts, keys, now));
  const vectorIds = doomed.map((fact) => fact.id);
  const chunks = deps.derived
    .listChunks()
    .filter((chunk) => chunkCovers(chunk, turnIds, texts, deps.store));
  for (const chunk of chunks) {
    vectorIds.push(chunk.chunkId);
  }
  const sessions = sessionsTouching(deps.store, turnIds, texts, deps.derived);
  const factIds = facts.map((fact) => fact.id);
  const forgottenAt = new Date(now).toISOString();
  const forgottenTurns = new Set<string>([
    ...deps.derived.forgottenTurnIds(),
    ...turnIds,
  ]);
  // TODO: a hard-erase option deletes the raw turn as well, including
  // its `turns_fts` row. John wants to test this flow first. Until then
  // the turn stays in `turns` and `turns_fts`, is kept as a dated entry,
  // and is never recalled. Retrieval filters the forgotten ids.
  let vectorDelete: Promise<void> = Promise.resolve();
  deps.derived.transaction(() => {
    dropProfileFor(deps.derived, facts, keys, forgottenTurns);
    for (const fact of doomed) {
      deps.derived.deleteFact(fact.id);
    }
    for (const turnId of turnIds) {
      deps.derived.forgetTurn(turnId, forgottenAt, factIds);
    }
    for (const chunk of chunks) {
      deps.derived.deleteChunk(chunk.chunkId);
    }
    deleteEmbedIndex(
      deps.store,
      turnIds,
      doomed.map((fact) => fact.id),
      chunks.map((chunk) => chunk.chunkId),
    );
    for (const sessionId of sessions) {
      deps.derived.deleteJournal(sessionId);
      regenerateSummary(deps, sessionId);
    }
    vectorDelete = deps.vectors.delete(vectorIds);
  });
  await vectorDelete;
  const turnList = [...turnIds].sort();
  deps.log?.(
    `memory.forget facts=${factIds.join(",")} turns=${turnList.join(",")}`,
  );
  if (candidates.length === 0) {
    return { forgotten: true, factIds };
  }
  return { forgotten: true, factIds, candidates };
}

async function factsToForget(
  deps: MemoryToolDeps,
  input: ForgetInput,
  now: number,
): Promise<ForgetMatch> {
  const active = activeFacts(deps.derived, now);
  if (input.factId !== undefined) {
    const found = active.find((fact) => fact.id === input.factId);
    return found === undefined
      ? { kind: "none" }
      : { kind: "facts", facts: [found], candidates: [] };
  }
  const needle = input.text?.trim() ?? "";
  if (needle.length < MIN_FORGET_TEXT) {
    return { kind: "too short" };
  }
  const lowered = needle.toLowerCase();
  const partial = active.filter((fact) =>
    fact.text.toLowerCase().includes(lowered),
  );
  const exact = partial.filter((fact) => fact.text.toLowerCase() === lowered);
  if (exact.length > 0) {
    const exactIds = new Set(exact.map((fact) => fact.id));
    return {
      kind: "facts",
      facts: exact,
      candidates: partial
        .filter((fact) => !exactIds.has(fact.id))
        .map((fact) => ({ id: fact.id, text: fact.text })),
    };
  }
  if (partial.length === 1) {
    const only = partial[0];
    return only === undefined
      ? { kind: "none" }
      : { kind: "facts", facts: [only], candidates: [] };
  }
  if (partial.length > 1) {
    return {
      kind: "ambiguous",
      candidates: partial.map((fact) => ({ id: fact.id, text: fact.text })),
    };
  }
  const nearest = await nearestActive(deps, needle, now);
  if (nearest !== null && nearest.distance <= FORGET_DISTANCE) {
    return { kind: "facts", facts: [nearest.fact], candidates: [] };
  }
  return { kind: "none" };
}

type TurnFallback =
  | {
      kind: "forget";
      keys: string[];
      turnIds: Set<string>;
      candidates: ForgetCandidate[];
    }
  | { kind: "ambiguous"; candidates: ForgetCandidate[] }
  | { kind: "none" };

/**
 * No fact matched. The same exact / unique / ambiguous rule applies to
 * turns, and then to chunks. The forget-request turn is not a second
 * candidate. A chosen turn's assistant reply is marked with it.
 */
function locateTurnOrChunk(
  deps: MemoryToolDeps,
  needleRaw: string,
): TurnFallback {
  const needle = needleRaw.trim().toLowerCase();
  if (needle.length < MIN_FORGET_TEXT) {
    return { kind: "none" };
  }
  const forgotten = new Set(deps.derived.forgottenTurnIds());
  const requestId = deps.state.sourceTurnId;
  const others: ForgetCandidate[] = [];
  let requestHit = false;
  for (const session of deps.store.listSessions()) {
    for (const turn of deps.store.recentTurns(session.id, 10_000)) {
      if (forgotten.has(turn.id)) {
        continue;
      }
      if (!turn.content.toLowerCase().includes(needle)) {
        continue;
      }
      if (turn.id === requestId) {
        requestHit = true;
        continue;
      }
      others.push({ id: turn.id, text: turn.content });
    }
  }
  const turnClass = classifyTextHits(others, needle);
  if (turnClass.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: turnClass.candidates };
  }
  if (turnClass.kind === "chosen" || requestHit) {
    const chosen = turnClass.kind === "chosen" ? turnClass.chosen : [];
    const keys = keyStrings([], needleRaw);
    for (const hit of chosen) {
      pushKey(keys, hit.text);
    }
    return {
      kind: "forget",
      keys,
      turnIds: turnIdsForHits(deps, chosen, requestHit),
      candidates: turnClass.kind === "chosen" ? turnClass.candidates : [],
    };
  }
  const chunks = deps.derived.listChunks().filter((chunk) => {
    if (chunk.firstTurn === requestId && chunk.lastTurn === requestId) {
      return false;
    }
    return chunk.text.toLowerCase().includes(needle);
  });
  const chunkClass = classifyTextHits(
    chunks.map((chunk) => ({ id: chunk.chunkId, text: chunk.text })),
    needle,
  );
  if (chunkClass.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: chunkClass.candidates };
  }
  if (chunkClass.kind === "none") {
    return { kind: "none" };
  }
  const keys = keyStrings([], needleRaw);
  for (const hit of chunkClass.chosen) {
    pushKey(keys, hit.text);
  }
  return {
    kind: "forget",
    keys,
    turnIds: turnIdsForHits(deps, [], false),
    candidates: chunkClass.candidates,
  };
}

function pushKey(keys: string[], text: string): void {
  const lowered = text.trim().toLowerCase();
  if (lowered.length >= MIN_FORGET_TEXT && !keys.includes(lowered)) {
    keys.push(lowered);
  }
}

function classifyTextHits(
  hits: ForgetCandidate[],
  needle: string,
):
  | { kind: "chosen"; chosen: ForgetCandidate[]; candidates: ForgetCandidate[] }
  | { kind: "ambiguous"; candidates: ForgetCandidate[] }
  | { kind: "none" } {
  if (hits.length === 0) {
    return { kind: "none" };
  }
  const exact = hits.filter((hit) => hit.text.trim().toLowerCase() === needle);
  if (exact.length > 0) {
    const ids = new Set(exact.map((hit) => hit.id));
    return {
      kind: "chosen",
      chosen: exact,
      candidates: hits.filter((hit) => !ids.has(hit.id)),
    };
  }
  if (hits.length === 1) {
    const only = hits[0];
    return only === undefined
      ? { kind: "none" }
      : { kind: "chosen", chosen: [only], candidates: [] };
  }
  return { kind: "ambiguous", candidates: hits };
}

/**
 * Chosen turns and each assistant reply. The forget request is included
 * when its own text matched, so an older unrelated turn is not marked.
 */
function turnIdsForHits(
  deps: MemoryToolDeps,
  chosen: readonly ForgetCandidate[],
  includeRequest: boolean,
): Set<string> {
  const turnIds = new Set<string>();
  for (const hit of chosen) {
    turnIds.add(hit.id);
  }
  if (includeRequest && deps.state.sourceTurnId !== null) {
    turnIds.add(deps.state.sourceTurnId);
  }
  pairReplies(deps.store, turnIds);
  return turnIds;
}

function pairReplies(store: MemoryStore, turnIds: Set<string>): void {
  for (const id of [...turnIds]) {
    const reply = pairedAssistant(store, id);
    if (reply !== null) {
      turnIds.add(reply);
    }
  }
}

/**
 * Once a fact is selected, every structural turn is marked: the source
 * turn, the assistant reply paired with it, the forget-request turn,
 * and that request's reply when it is already stored. Any other turn
 * whose text contains a key string is marked too. Several turns never
 * refuse the forget. Ambiguity stays a fact-selection concern.
 */
function turnsToForget(
  deps: MemoryToolDeps,
  facts: readonly FactRecord[],
  keys: readonly string[],
): Set<string> {
  const turnIds = new Set<string>();
  const mark = (turnId: string | null): void => {
    if (turnId === null || turnId.length === 0) {
      return;
    }
    turnIds.add(turnId);
    const reply = pairedAssistant(deps.store, turnId);
    if (reply !== null) {
      turnIds.add(reply);
    }
  };
  for (const fact of facts) {
    mark(fact.sourceTurn);
  }
  mark(deps.state.sourceTurnId);
  for (const session of deps.store.listSessions()) {
    for (const turn of deps.store.recentTurns(session.id, 10_000)) {
      if (containsKey(turn.content, keys)) {
        turnIds.add(turn.id);
      }
    }
  }
  return turnIds;
}

function pairedAssistant(
  store: MemoryStore,
  userTurnId: string,
): string | null {
  for (const session of store.listSessions()) {
    const turns = store.recentTurns(session.id, 10_000);
    const index = turns.findIndex((turn) => turn.id === userTurnId);
    if (index < 0) {
      continue;
    }
    for (let cursor = index + 1; cursor < turns.length; cursor += 1) {
      const turn = turns[cursor];
      if (turn === undefined) {
        continue;
      }
      if (turn.role === "user") {
        return null;
      }
      if (turn.role === "assistant") {
        return turn.id;
      }
    }
    return null;
  }
  return null;
}

function keyStrings(
  facts: readonly FactRecord[],
  needle: string | undefined,
): string[] {
  const keys: string[] = [];
  const add = (value: string | undefined): void => {
    const text = value?.trim().toLowerCase() ?? "";
    if (text.length >= MIN_FORGET_TEXT && !keys.includes(text)) {
      keys.push(text);
    }
  };
  add(needle);
  for (const fact of facts) {
    add(fact.text);
  }
  return keys;
}

function containsKey(text: string, keys: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return keys.some((key) => haystack.includes(key));
}

/**
 * Active matches, plus superseded, expired, and tombstone copies that
 * share the source turn, the text, or a key string.
 */
function copyOfForgotten(
  fact: FactRecord,
  matched: readonly FactRecord[],
  keys: readonly string[],
  now: number,
): boolean {
  if (matched.some((item) => item.id === fact.id)) {
    return true;
  }
  if (isActiveFact(fact, now)) {
    return false;
  }
  if (
    matched.some((item) => item.text.toLowerCase() === fact.text.toLowerCase())
  ) {
    return true;
  }
  if (
    fact.sourceTurn !== null &&
    matched.some((item) => item.sourceTurn === fact.sourceTurn)
  ) {
    return true;
  }
  return containsKey(fact.text, keys);
}

function chunkCovers(
  chunk: ChunkRecord,
  turnIds: ReadonlySet<string>,
  texts: readonly string[],
  store: MemoryStore,
): boolean {
  if (chunk.firstTurn !== null && turnIds.has(chunk.firstTurn)) {
    return true;
  }
  if (chunk.lastTurn !== null && turnIds.has(chunk.lastTurn)) {
    return true;
  }
  if (
    chunk.sessionId !== null &&
    chunk.firstTurn !== null &&
    chunk.lastTurn !== null &&
    spanCovers(store, chunk.sessionId, chunk.firstTurn, chunk.lastTurn, turnIds)
  ) {
    return true;
  }
  const haystack = chunk.text.toLowerCase();
  return texts.some((text) => {
    const needle = text.trim().toLowerCase();
    return needle.length >= MIN_FORGET_TEXT && haystack.includes(needle);
  });
}

function spanCovers(
  store: MemoryStore,
  sessionId: string,
  firstTurn: string,
  lastTurn: string,
  turnIds: ReadonlySet<string>,
): boolean {
  const turns = store.recentTurns(sessionId, 10_000);
  const ends = turns.filter(
    (turn) => turn.id === firstTurn || turn.id === lastTurn,
  );
  if (ends.length === 0) {
    return false;
  }
  const start = Math.min(...ends.map((turn) => turn.createdAt));
  const end = Math.max(...ends.map((turn) => turn.createdAt));
  return turns.some(
    (turn) =>
      turn.createdAt >= start && turn.createdAt <= end && turnIds.has(turn.id),
  );
}

function sessionsTouching(
  store: MemoryStore,
  turnIds: ReadonlySet<string>,
  texts: readonly string[],
  derived: DerivedMemoryStore,
): string[] {
  const sessions = new Set<string>();
  for (const session of store.listSessions()) {
    const turns = store.recentTurns(session.id, 10_000);
    if (turns.some((turn) => turnIds.has(turn.id))) {
      sessions.add(session.id);
    }
  }
  for (const entry of derived.listJournal()) {
    if (entry.sessionId === null) {
      continue;
    }
    if (texts.some((text) => entry.entry.includes(text))) {
      sessions.add(entry.sessionId);
    }
  }
  for (const chunk of derived.listChunks()) {
    if (chunk.sessionId !== null && chunkCovers(chunk, turnIds, texts, store)) {
      sessions.add(chunk.sessionId);
    }
  }
  return [...sessions];
}

function regenerateSummary(deps: MemoryToolDeps, sessionId: string): void {
  // Every forgotten turn, including ones an earlier forget in this
  // session already marked. This call's ids are in the table because
  // `forgetTurn` runs first in the same transaction.
  const forgotten = new Set(deps.derived.forgottenTurnIds());
  const remaining = deps.store
    .recentTurns(sessionId, 10_000)
    .filter((turn) => !forgotten.has(turn.id) && !isSecret(turn.content));
  const text = remaining
    .map((turn) => turn.content.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 500);
  if (text.length === 0) {
    deps.derived.clearSummary(sessionId);
    return;
  }
  deps.derived.setSummary(sessionId, text);
}

export async function nearestActive(
  deps: {
    derived: DerivedMemoryStore;
    embedder: Embedder;
    vectors: VectorIndex;
  },
  text: string,
  now: number,
): Promise<{ fact: FactRecord; distance: number } | null> {
  const embedding = await deps.embedder.embed(prefixQuery(text));
  const hits = await deps.vectors.knn("vec_facts", embedding, 8);
  for (const hit of hits) {
    const fact = deps.derived.factById(hit.id);
    if (fact === null || !isActiveFact(fact, now)) {
      continue;
    }
    return { fact, distance: hit.distance };
  }
  return null;
}

export async function embedFact(
  deps: { embedder: Embedder; vectors: VectorIndex },
  fact: FactRecord,
): Promise<void> {
  if (fact.subject === TOMBSTONE_SUBJECT) {
    return;
  }
  const embedding = await deps.embedder.embed(prefixDocument(fact.text));
  await deps.vectors.upsert("vec_facts", fact.id, embedding);
}

export function tombstone(
  id: string,
  fact: FactRecord,
  now: number,
  alsoId?: string,
): FactRecord {
  const extra = alsoId === undefined ? "" : ` ${alsoId}`;
  return {
    id,
    text: `Superseded ${fact.id}${extra}`,
    kind: fact.kind,
    subject: TOMBSTONE_SUBJECT,
    confidence: 1,
    sensitive: fact.sensitive,
    validUntil: null,
    supersededBy: null,
    sourceTurn: fact.sourceTurn,
    createdAt: now,
    lastUsedAt: null,
  };
}

function dropProfileFor(
  derived: DerivedMemoryStore,
  facts: readonly FactRecord[],
  keys: readonly string[],
  forgottenTurns: ReadonlySet<string>,
): void {
  const rows = derived.listProfile();
  const nameTokens = profileNameTokens(rows);
  const next = rows.filter(
    (row) => !profileRowDropped(row, facts, keys, forgottenTurns, nameTokens),
  );
  if (next.length === rows.length) {
    return;
  }
  derived.replaceProfile(next);
}

const NAME_KEYS = new Set([
  "name",
  "full_name",
  "first_name",
  "last_name",
  "given_name",
  "family_name",
]);

/** Tokens from profile rows that store John's name. */
export function profileNameTokens(rows: readonly ProfileRecord[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim().toLowerCase();
    if (!NAME_KEYS.has(key) && !key.endsWith("_name")) {
      continue;
    }
    for (const token of row.value.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (token.length >= 2) {
        out.add(token);
      }
    }
  }
  return out;
}

/**
 * A pinned row drops only when its key matches the forget, or a
 * forgotten fact contains its value. An unpinned row also drops when
 * its source turn was forgotten, or when its value holds a secret
 * token from the forget (a digit run of 3 or more that is not a year,
 * or a rare word). The profile name is not a secret token. An active
 * sibling fact on that turn still stays.
 */
export function profileRowDropped(
  row: ProfileRecord,
  facts: readonly FactRecord[],
  keys: readonly string[],
  forgottenTurns: ReadonlySet<string>,
  nameTokens: ReadonlySet<string>,
): boolean {
  if (profileKeyMatches(row.key, keys)) {
    return true;
  }
  if (
    facts.some((fact) =>
      factContainsProfileValue(row.value, fact.text, nameTokens),
    ) ||
    keys.some((key) => factContainsProfileValue(row.value, key, nameTokens))
  ) {
    return true;
  }
  if (row.pinned) {
    return false;
  }
  if (row.sourceTurn !== null && forgottenTurns.has(row.sourceTurn)) {
    return true;
  }
  const value = row.value.trim().toLowerCase();
  if (
    value.length >= MIN_FORGET_TEXT &&
    !isNameOnlyValue(value, nameTokens) &&
    containsKey(value, keys)
  ) {
    return true;
  }
  return valueHasSecret(value, keys, nameTokens);
}

function profileKeyMatches(key: string, keys: readonly string[]): boolean {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < MIN_FORGET_TEXT) {
    return false;
  }
  const pattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`,
  );
  return keys.some((item) => pattern.test(item));
}

function factContainsProfileValue(
  value: string,
  factText: string,
  nameTokens: ReadonlySet<string>,
): boolean {
  const needle = value.trim().toLowerCase();
  if (needle.length < MIN_FORGET_TEXT || isNameOnlyValue(needle, nameTokens)) {
    return false;
  }
  return factText.toLowerCase().includes(needle);
}

function isNameOnlyValue(
  value: string,
  nameTokens: ReadonlySet<string>,
): boolean {
  if (nameTokens.size === 0) {
    return false;
  }
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => nameTokens.has(token));
}

/** A 4-digit year in 1900–2099 is a date, not a secret. */
function isYearToken(run: string): boolean {
  if (run.length !== 4) {
    return false;
  }
  const year = Number(run);
  return year >= 1900 && year <= 2099;
}

/**
 * Digit runs of 3 or more that are not years, and rare words (7 or
 * more letters) that are not the profile name. Ordinary words in the
 * fact, such as "locker" or "code", are not secrets.
 */
export function secretTokens(
  text: string,
  nameTokens: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const add = (token: string): void => {
    if (!out.includes(token)) {
      out.push(token);
    }
  };
  for (const run of text.match(/\d+/g) ?? []) {
    if (run.length >= 3 && !isYearToken(run)) {
      add(run);
    }
  }
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (
      word.length < 7 ||
      PROFILE_STOPWORDS.has(word) ||
      nameTokens.has(word)
    ) {
      continue;
    }
    add(word);
  }
  return out;
}

function valueHasSecret(
  value: string,
  texts: readonly string[],
  nameTokens: ReadonlySet<string>,
): boolean {
  const haystack = value.toLowerCase();
  const secrets = texts.flatMap((text) => secretTokens(text, nameTokens));
  return secrets.some((token) => {
    if (/^\d+$/.test(token)) {
      return new RegExp(`(^|\\D)${token}(\\D|$)`).test(haystack);
    }
    return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(haystack);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROFILE_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "this",
  "that",
  "was",
  "be",
  "as",
  "at",
  "by",
  "from",
  "has",
  "have",
  "had",
  "not",
  "but",
  "if",
  "so",
  "than",
  "then",
  "too",
  "very",
  "can",
  "will",
  "just",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "out",
  "up",
  "down",
  "off",
  "no",
  "yes",
  "do",
  "does",
  "did",
  "done",
  "i",
  "me",
  "we",
  "you",
  "he",
  "she",
  "they",
  "them",
  "what",
  "when",
  "where",
  "who",
  "how",
  "which",
  "there",
  "here",
]);

type SqlStatement = { run: (param: string) => unknown };
type SqlDatabase = { prepare: (sql: string) => SqlStatement };

/**
 * Drop `embed_index` rows for forgotten turns, deleted facts, and
 * purged chunks. In-memory stores have no index table.
 */
function deleteEmbedIndex(
  store: MemoryStore,
  turnIds: ReadonlySet<string>,
  factIds: readonly string[],
  chunkIds: readonly string[] = [],
): void {
  const open = (store as { database?: () => SqlDatabase }).database;
  if (typeof open !== "function") {
    return;
  }
  const db = open.call(store);
  const dropTurn = db.prepare(
    "DELETE FROM embed_index WHERE source = 'turn' AND source_id = ?",
  );
  const dropFact = db.prepare(
    "DELETE FROM embed_index WHERE source = 'fact' AND source_id = ?",
  );
  const dropId = db.prepare("DELETE FROM embed_index WHERE id = ?");
  for (const id of turnIds) {
    dropTurn.run(id);
  }
  for (const id of factIds) {
    dropFact.run(id);
  }
  for (const id of chunkIds) {
    dropId.run(id);
  }
}

function profileKeyFor(
  requested: string | undefined,
  fact: FactRecord,
): string {
  const raw = requested?.trim() || fact.subject?.trim() || slug(fact.text);
  const cleaned = raw.replace(/\s+/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "note";
}

function slug(text: string): string {
  const lowered = text.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const trimmed = lowered.replace(/^_+|_+$/g, "");
  return trimmed.slice(0, 64);
}

function cleanSubject(subject: string | null | undefined): string | null {
  if (subject === undefined || subject === null) {
    return null;
  }
  const trimmed = subject.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value);
}
