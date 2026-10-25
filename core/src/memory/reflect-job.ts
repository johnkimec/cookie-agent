import type {
  DerivedMemoryStore,
  FactKind,
  FactRecord,
  ProfileRecord,
} from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import { DUPLICATE_DISTANCE, isSecret, isVerbatimScreen } from "./policy.ts";
import { capProfile } from "./profile-cap.ts";
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
}

/**
 * Idle reflect job. The scheduler holds the llama slot and aborts
 * `signal` when a chat starts. Writes happen only after the model
 * returns and the signal is still clear.
 */
export class LocalReflector {
  private signal: AbortSignal = new AbortController().signal;
  private readonly options: LocalReflectorOptions;

  constructor(options: LocalReflectorOptions) {
    this.options = options;
  }

  bindSignal(signal: AbortSignal): void {
    this.signal = signal;
  }

  async reflect(sessionId: string): Promise<void> {
    const signal = this.signal;
    const turns = this.options.store.recentTurns(sessionId, 10_000);
    if (turns.length === 0) {
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
    throwIfAborted(signal);
    const extracted = parseReflectExtraction(raw);
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    this.writeSummary(sessionId, extracted.summary, signal);
    this.writeJournal(sessionId, extracted.journal, signal);
    for (const candidate of extracted.facts) {
      throwIfAborted(signal);
      await this.writeFact(candidate, turnById, signal);
    }
    this.writeProfile(extracted.profile, signal);
  }

  private writeSummary(
    sessionId: string,
    summary: string,
    signal: AbortSignal,
  ): void {
    throwIfAborted(signal);
    const text = summary.trim().slice(0, 500);
    if (text.length === 0 || isSecret(text)) {
      return;
    }
    this.options.derived.setSummary(sessionId, text);
  }

  private writeJournal(
    sessionId: string,
    entry: string,
    signal: AbortSignal,
  ): void {
    throwIfAborted(signal);
    const text = entry.trim().slice(0, 2000);
    if (text.length === 0 || isSecret(text)) {
      return;
    }
    if (this.options.derived.listJournal(sessionId).length > 0) {
      return;
    }
    const now = this.options.now();
    this.options.derived.insertJournal({
      id: this.options.journalIds(),
      day: this.options.localDay(now, this.options.timeZone),
      entry: text,
      sessionId,
      createdAt: now,
    });
  }

  private async writeFact(
    candidate: ReflectFact,
    turnById: Map<string, TurnRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const text = candidate.text.trim().slice(0, 500);
    const turn = turnById.get(candidate.sourceTurn);
    if (text.length === 0 || turn === undefined) {
      return;
    }
    if (isSecret(text) || isVerbatimScreen(text, turn)) {
      return;
    }
    const now = this.options.now();
    if (candidate.contradicts !== null) {
      const prior = this.options.derived.factById(candidate.contradicts);
      if (prior !== null && prior.supersededBy === null) {
        const created = this.insertFact(candidate, text, now);
        this.options.derived.updateFact({
          ...prior,
          supersededBy: created.id,
        });
        await embedFact(this.options, created);
        return;
      }
    }
    const nearest = await nearestActive(this.options, text, now);
    throwIfAborted(signal);
    if (nearest !== null && nearest.distance <= DUPLICATE_DISTANCE) {
      this.options.derived.updateFact({ ...nearest.fact, lastUsedAt: now });
      return;
    }
    const created = this.insertFact(candidate, text, now);
    await embedFact(this.options, created);
  }

  private insertFact(
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
    this.options.derived.insertFact(fact);
    return fact;
  }

  private writeProfile(rows: ReflectProfile[], signal: AbortSignal): void {
    throwIfAborted(signal);
    const now = this.options.now();
    for (const row of rows) {
      if (!promoteProfile(row) || isSecret(row.value) || isSecret(row.key)) {
        continue;
      }
      const key = row.key.trim().replace(/\s+/g, "_").slice(0, 64);
      const value = row.value.trim().slice(0, 500);
      if (key.length === 0 || value.length === 0) {
        continue;
      }
      const record: ProfileRecord = {
        key,
        value,
        pinned: row.pinned && row.statedByJohn,
        shareable: row.shareable && !row.sensitive,
        sourceTurn: null,
        updatedAt: now,
      };
      this.options.derived.upsertProfile(record);
    }
    this.options.derived.replaceProfile(
      capProfile(this.options.derived.listProfile()),
    );
  }
}

export function promoteProfile(row: ReflectProfile): boolean {
  if (row.stable && row.statedByJohn) {
    return true;
  }
  return row.sessionsObserved >= 3;
}

export function renderReflectPrompt(
  sessionId: string,
  turns: readonly TurnRecord[],
  facts: readonly FactRecord[],
): string {
  const turnLines = turns.map(
    (turn) =>
      `- id=${turn.id} role=${turn.role} tainted=${turn.tainted ? "true" : "false"} text=${turn.content}`,
  );
  const factLines = facts
    .filter(
      (fact) =>
        fact.supersededBy === null && fact.subject !== "memory:tombstone",
    )
    .map((fact) => `- id=${fact.id} text=${fact.text}`);
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
  reflect: (sessionId: string) => Promise<void>;
}): Promise<void> {
  args.derived.clearDerived();
  for (const sessionId of args.sessionIds) {
    await args.reflect(sessionId);
  }
}
