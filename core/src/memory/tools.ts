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
import { documentInput, type Embedder, queryInput } from "./embedder.ts";
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
        "Forget a fact John asked to drop. Deletes that fact, its profile row, and derived rows built from its turn. Raw turns stay. If several facts match and none is an exact match, returns the candidates and deletes nothing.",
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

type ForgetMatch =
  | { kind: "facts"; facts: FactRecord[] }
  | { kind: "ambiguous"; candidates: Array<{ id: string; text: string }> }
  | { kind: "too short" }
  | { kind: "none" };

async function forgetFact(
  deps: MemoryToolDeps,
  input: ForgetInput,
): Promise<
  | { forgotten: true; factIds: string[] }
  | { forgotten: false; reason: "not found" | "too short" }
  | {
      forgotten: false;
      reason: "ambiguous";
      candidates: Array<{ id: string; text: string }>;
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
    return { forgotten: false, reason: "not found" };
  }
  const facts = match.facts;
  const turnIds = new Set<string>();
  const vectorIds = facts.map((fact) => fact.id);
  const texts = facts.map((fact) => fact.text);
  for (const fact of facts) {
    if (fact.sourceTurn !== null) {
      turnIds.add(fact.sourceTurn);
    }
  }
  const chunks = deps.derived
    .listChunks()
    .filter((chunk) => chunkCovers(chunk, turnIds, texts));
  for (const chunk of chunks) {
    vectorIds.push(chunk.chunkId);
  }
  const sessions = sessionsTouching(deps.store, turnIds, texts, deps.derived);
  const factsByTurn = new Map<string, string[]>();
  for (const fact of facts) {
    if (fact.sourceTurn === null) {
      continue;
    }
    const ids = factsByTurn.get(fact.sourceTurn) ?? [];
    ids.push(fact.id);
    factsByTurn.set(fact.sourceTurn, ids);
  }
  const forgottenAt = new Date(now).toISOString();
  // TODO: a hard-erase option deletes the raw turn as well. John wants
  // to test this flow first. Until then the turn stays in `turns`, is
  // kept as a dated entry, and is never recalled.
  deps.derived.transaction(() => {
    for (const fact of facts) {
      dropProfileFor(deps.derived, fact);
      deps.derived.deleteFact(fact.id);
    }
    for (const [turnId, ids] of factsByTurn) {
      deps.derived.forgetTurn(turnId, forgottenAt, ids);
    }
    for (const chunk of chunks) {
      deps.derived.deleteChunk(chunk.chunkId);
    }
    for (const sessionId of sessions) {
      deps.derived.deleteJournal(sessionId);
      regenerateSummary(deps, sessionId, turnIds);
    }
  });
  await deps.vectors.delete(vectorIds);
  const turnList = [...turnIds].sort();
  deps.log?.(
    `memory.forget facts=${facts.map((fact) => fact.id).join(",")} turns=${turnList.join(",")}`,
  );
  return { forgotten: true, factIds: facts.map((fact) => fact.id) };
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
      : { kind: "facts", facts: [found] };
  }
  const needle = input.text?.trim() ?? "";
  if (needle.length < MIN_FORGET_TEXT) {
    return { kind: "too short" };
  }
  const lowered = needle.toLowerCase();
  const exact = active.filter((fact) => fact.text.toLowerCase() === lowered);
  if (exact.length > 0) {
    return { kind: "facts", facts: exact };
  }
  const partial = active.filter((fact) =>
    fact.text.toLowerCase().includes(lowered),
  );
  if (partial.length === 1) {
    const only = partial[0];
    return only === undefined
      ? { kind: "none" }
      : { kind: "facts", facts: [only] };
  }
  if (partial.length > 1) {
    return {
      kind: "ambiguous",
      candidates: partial.map((fact) => ({ id: fact.id, text: fact.text })),
    };
  }
  const nearest = await nearestActive(deps, needle, now);
  if (nearest !== null && nearest.distance <= FORGET_DISTANCE) {
    return { kind: "facts", facts: [nearest.fact] };
  }
  return { kind: "none" };
}

function chunkCovers(
  chunk: ChunkRecord,
  turnIds: ReadonlySet<string>,
  texts: readonly string[],
): boolean {
  if (chunk.firstTurn !== null && turnIds.has(chunk.firstTurn)) {
    return true;
  }
  if (chunk.lastTurn !== null && turnIds.has(chunk.lastTurn)) {
    return true;
  }
  const haystack = chunk.text.toLowerCase();
  return texts.some((text) => {
    const needle = text.trim().toLowerCase();
    return needle.length >= MIN_FORGET_TEXT && haystack.includes(needle);
  });
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
    if (chunk.sessionId !== null && chunkCovers(chunk, turnIds, texts)) {
      sessions.add(chunk.sessionId);
    }
  }
  return [...sessions];
}

function regenerateSummary(
  deps: MemoryToolDeps,
  sessionId: string,
  forgotten: ReadonlySet<string>,
): void {
  const remaining = deps.store
    .recentTurns(sessionId, 10_000)
    .filter((turn) => !forgotten.has(turn.id));
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
  const embedding = await deps.embedder.embed(queryInput(text));
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
  const embedding = await deps.embedder.embed(documentInput(fact.text));
  await deps.vectors.upsert("vec_facts", fact.id, embedding);
}

export function tombstone(
  id: string,
  fact: FactRecord,
  now: number,
): FactRecord {
  return {
    id,
    text: `Superseded ${fact.id}`,
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

function dropProfileFor(derived: DerivedMemoryStore, fact: FactRecord): void {
  const next = derived.listProfile().filter((row) => row.value !== fact.text);
  if (next.length === derived.listProfile().length) {
    return;
  }
  derived.replaceProfile(next);
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
