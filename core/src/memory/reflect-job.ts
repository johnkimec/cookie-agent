import type {
  DerivedMemoryStore,
  FactKind,
  FactRecord,
  ProfileRecord,
} from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import { DUPLICATE_DISTANCE, isSecret, isVerbatimScreen } from "./policy.ts";
import {
  capProfile,
  estimateTokens,
  PROFILE_TOKEN_CAP,
} from "./profile-cap.ts";
import type { ReflectOptions, Reflector } from "./reflect.ts";
import { abortError, isAbortError } from "./slot.ts";
import type { MemoryStore } from "./store.ts";
import { embedFact, isFactKind, nearestActive } from "./tools.ts";
import type { TurnRecord } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

export const REFLECT_SYSTEM_PROMPT = [
  "You extract memory for Cookie. Reply with one JSON object and no other text.",
  "journal is a 2 to 6 sentence recap of this session.",
  "summary is one line.",
  "facts are atomic. Each sourceTurn must be a turn id from the prompt.",
  "Set contradicts to an existing fact id when the new fact replaces it, otherwise null.",
  "Do not copy secrets, credentials, or verbatim screen text.",
  "profile entries are only stable facts John stated, or facts seen in 3 or more sessions.",
].join(" ");

export interface ReflectExtraction {
  journal: string;
  summary: string;
  facts: ReflectFact[];
  profile: ReflectProfile[];
}

export interface ReflectFact {
  text: string;
  kind: FactKind;
  subject: string | null;
  confidence: number;
  sensitive: boolean;
  validUntil: number | null;
  sourceTurn: string;
  contradicts: string | null;
}

export interface ReflectProfile {
  key: string;
  value: string;
  statedByJohn: boolean;
  stable: boolean;
  sessionsObserved: number;
  shareable: boolean;
  sensitive: boolean;
  pinned: boolean;
}

export type TextComplete = (args: {
  system: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface LocalReflectorOptions {
  store: MemoryStore;
  derived: DerivedMemoryStore;
  embedder: Embedder;
  vectors: VectorIndex;
  complete: TextComplete;
  now: () => number;
  timeZone: string;
  localDay: (epochMs: number, timeZone: string) => string;
  factIds: () => string;
  journalIds: () => string;
  log?: (message: string) => void;
}

/** About 6k tokens of recent turns plus the highest-confidence facts. */
export const REFLECT_PROMPT_TOKEN_CAP = 6_000;

/**
 * Idle reflect job. The scheduler holds the llama slot and aborts
 * `signal` when a chat starts. Once the model has returned, the abort
 * is ignored and every derived write commits together, summary last.
 */
export class LocalReflector implements Reflector {
  private readonly options: LocalReflectorOptions;

  constructor(options: LocalReflectorOptions) {
    this.options = options;
  }

  async reflect(sessionId: string, opts?: ReflectOptions): Promise<void> {
    const signal = opts?.signal ?? new AbortController().signal;
    const forgotten = new Set(this.options.derived.forgottenTurnIds());
    const turns = this.options.store
      .recentTurns(sessionId, 10_000)
      .filter((turn) => !forgotten.has(turn.id));
    if (turns.length === 0) {
      if (this.options.store.recentTurns(sessionId, 1).length > 0) {
        this.options.derived.setSummary(sessionId, "");
      }
      return;
    }
    throwIfAborted(signal);
    const prompt = renderReflectPrompt(
      sessionId,
      turns,
      this.options.derived.listFacts(),
    );
    let raw: string;
    try {
      raw = await this.options.complete({
        system: REFLECT_SYSTEM_PROMPT,
        prompt,
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw abortError();
      }
      throw error;
    }
    const extracted = parseReflectExtraction(raw);
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    const planned = await this.planFacts(extracted.facts, turnById, forgotten);
    const now = this.options.now();
    const journal = this.planJournal(sessionId, extracted.journal, now);
    const profile = this.planProfile(extracted.profile, now);
    const summary = cleanSummary(extracted.summary);
    this.options.derived.transaction(() => {
      if (journal !== null) {
        this.options.derived.insertJournal(journal);
      }
      for (const fact of planned.inserts) {
        this.options.derived.insertFact(fact);
      }
      for (const fact of planned.updates) {
        this.options.derived.updateFact(fact);
      }
      for (const row of profile) {
        this.options.derived.upsertProfile(row);
      }
      capProfile(
        this.options.derived.listProfile(),
        PROFILE_TOKEN_CAP,
        this.options.log ?? (() => undefined),
      );
      if (summary !== null) {
        this.options.derived.setSummary(sessionId, summary);
      }
    });
    for (const fact of planned.inserts) {
      await embedFact(this.options, fact);
    }
  }

  private planJournal(
    sessionId: string,
    entry: string,
    now: number,
  ): {
    id: string;
    day: string;
    entry: string;
    sessionId: string;
    createdAt: number;
  } | null {
    const text = entry.trim().slice(0, 2000);
    if (text.length === 0 || isSecret(text)) {
      return null;
    }
    if (this.options.derived.listJournal(sessionId).length > 0) {
      return null;
    }
    return {
      id: this.options.journalIds(),
      day: this.options.localDay(now, this.options.timeZone),
      entry: text,
      sessionId,
      createdAt: now,
    };
  }

  private async planFacts(
    candidates: readonly ReflectFact[],
    turnById: Map<string, TurnRecord>,
    forgotten: ReadonlySet<string>,
  ): Promise<{ inserts: FactRecord[]; updates: FactRecord[] }> {
    const inserts: FactRecord[] = [];
    const updates: FactRecord[] = [];
    for (const candidate of candidates) {
      const text = candidate.text.trim().slice(0, 500);
      const turn = turnById.get(candidate.sourceTurn);
      if (text.length === 0 || turn === undefined) {
        continue;
      }
      if (forgotten.has(candidate.sourceTurn)) {
        continue;
      }
      if (isSecret(text) || isVerbatimScreen(text, turn)) {
        continue;
      }
      const now = this.options.now();
      if (candidate.contradicts !== null) {
        // TODO(M1): reject contradicts when the source turn is tainted.
        // A screen or file quote must not supersede a fact John stated.
        const prior = this.options.derived.factById(candidate.contradicts);
        if (prior !== null && prior.supersededBy === null) {
          const created = this.makeFact(candidate, text, now);
          inserts.push(created);
          updates.push({ ...prior, supersededBy: created.id });
          continue;
        }
      }
      if (
        inserts.some((fact) => fact.text.toLowerCase() === text.toLowerCase())
      ) {
        continue;
      }
      const nearest = await nearestActive(this.options, text, now);
      if (nearest !== null && nearest.distance <= DUPLICATE_DISTANCE) {
        updates.push({ ...nearest.fact, lastUsedAt: now });
        continue;
      }
      inserts.push(this.makeFact(candidate, text, now));
    }
    return { inserts, updates };
  }

  private planProfile(rows: ReflectProfile[], now: number): ProfileRecord[] {
    const planned: ProfileRecord[] = [];
    for (const row of rows) {
      if (!promoteProfile(row) || isSecret(row.value) || isSecret(row.key)) {
        continue;
      }
      const key = row.key.trim().replace(/\s+/g, "_").slice(0, 64);
      const value = row.value.trim().slice(0, 500);
      if (key.length === 0 || value.length === 0) {
        continue;
      }
      planned.push({
        key,
        value,
        pinned: row.pinned && row.statedByJohn,
        shareable: row.shareable && !row.sensitive,
        sourceTurn: null,
        updatedAt: now,
      });
    }
    return planned;
  }

  private makeFact(
    candidate: ReflectFact,
    text: string,
    now: number,
  ): FactRecord {
    const fact: FactRecord = {
      id: this.options.factIds(),
      text,
      kind: candidate.kind,
      subject: candidate.subject,
      confidence: candidate.confidence,
      sensitive: candidate.sensitive,
      validUntil: candidate.validUntil,
      supersededBy: null,
      sourceTurn: candidate.sourceTurn,
      createdAt: now,
      lastUsedAt: null,
    };
    return fact;
  }
}

function cleanSummary(summary: string): string | null {
  const text = summary.trim().slice(0, 500);
  if (text.length === 0 || isSecret(text)) {
    return null;
  }
  return text;
}

export function promoteProfile(row: ReflectProfile): boolean {
  if (row.stable && row.statedByJohn) {
    return true;
  }
  return row.sessionsObserved >= 3;
}

export function selectReflectContext(
  turns: readonly TurnRecord[],
  facts: readonly FactRecord[],
  cap: number = REFLECT_PROMPT_TOKEN_CAP,
): { turns: TurnRecord[]; facts: FactRecord[] } {
  const selectedTurns: TurnRecord[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const cost = estimateTokens(reflectTurnLine(turn));
    if (selectedTurns.length > 0 && used + cost > cap) {
      break;
    }
    selectedTurns.push(turn);
    used += cost;
  }
  selectedTurns.reverse();
  const ranked = facts
    .filter(
      (fact) =>
        fact.supersededBy === null && fact.subject !== "memory:tombstone",
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence || left.id.localeCompare(right.id),
    );
  const selectedFacts: FactRecord[] = [];
  for (const fact of ranked) {
    const cost = estimateTokens(fact.text) + 4;
    if (selectedFacts.length > 0 && used + cost > cap) {
      break;
    }
    selectedFacts.push(fact);
    used += cost;
  }
  return { turns: selectedTurns, facts: selectedFacts };
}

function reflectTurnLine(turn: TurnRecord): string {
  return `- id=${turn.id} role=${turn.role} tainted=${turn.tainted ? "true" : "false"} text=${turn.content}`;
}

export function renderReflectPrompt(
  sessionId: string,
  turns: readonly TurnRecord[],
  facts: readonly FactRecord[],
): string {
  const selected = selectReflectContext(turns, facts);
  const turnLines = selected.turns.map(reflectTurnLine);
  const factLines = selected.facts.map(
    (fact) => `- id=${fact.id} text=${fact.text}`,
  );
  return [
    `Session ${sessionId}`,
    "Turns:",
    turnLines.join("\n"),
    "Active facts:",
    factLines.length > 0 ? factLines.join("\n") : "(none)",
  ].join("\n");
}

export function parseReflectExtraction(raw: string): ReflectExtraction {
  const parsed = JSON.parse(stripFence(raw)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("reflect JSON was not an object");
  }
  return {
    journal: readString(parsed.journal),
    summary: readString(parsed.summary),
    facts: readFacts(parsed.facts),
    profile: readProfile(parsed.profile),
  };
}

function readFacts(value: unknown): ReflectFact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const facts: ReflectFact[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const text = readString(entry.text);
    const kind = readString(entry.kind);
    const sourceTurn = readString(entry.sourceTurn);
    const confidence = readConfidence(entry.confidence);
    if (text.length === 0 || !isFactKind(kind) || sourceTurn.length === 0) {
      continue;
    }
    if (confidence === null) {
      continue;
    }
    facts.push({
      text,
      kind,
      subject: readNullableString(entry.subject),
      confidence,
      sensitive: entry.sensitive === true,
      validUntil: readNullableNumber(entry.validUntil),
      sourceTurn,
      contradicts: readNullableString(entry.contradicts),
    });
  }
  return facts;
}

function readProfile(value: unknown): ReflectProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: ReflectProfile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const key = readString(entry.key);
    const text = readString(entry.value);
    if (key.length === 0 || text.length === 0) {
      continue;
    }
    const observed = entry.sessionsObserved;
    rows.push({
      key,
      value: text,
      statedByJohn: entry.statedByJohn === true,
      stable: entry.stable === true,
      sessionsObserved:
        typeof observed === "number" && observed > 0 ? observed : 0,
      shareable: entry.shareable !== false,
      sensitive: entry.sensitive === true,
      pinned: entry.pinned === true,
    });
  }
  return rows;
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced?.[1]?.trim() ?? trimmed;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function readConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

/** Drop derived rows and run reflect again for each session. */
export async function rebuildDerivedMemory(args: {
  sessionIds: readonly string[];
  derived: DerivedMemoryStore;
  vectors: VectorIndex;
  reflect: (sessionId: string, opts?: ReflectOptions) => Promise<void>;
}): Promise<void> {
  const ids = [
    ...args.derived.listFacts().map((fact) => fact.id),
    ...args.derived.listChunks().map((chunk) => chunk.chunkId),
  ];
  await args.vectors.delete(ids);
  args.derived.clearDerived();
  for (const sessionId of args.sessionIds) {
    await args.reflect(sessionId);
  }
}
