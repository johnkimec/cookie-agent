import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  type DerivedMemoryStore,
  FACT_KINDS,
  type FactKind,
  type FactRecord,
  type ProfileRecord,
  TOMBSTONE_SUBJECT,
} from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import {
  activeFacts,
  FORGET_DISTANCE,
  isActiveFact,
  isSecret,
} from "./policy.ts";
import { capProfile } from "./profile-cap.ts";
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

export interface MemoryToolDeps {
  derived: DerivedMemoryStore;
  embedder: Embedder;
  vectors: VectorIndex;
  state: MemoryToolState;
  now: () => number;
  ids: () => string;
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
        "Forget a fact John asked to drop. The old row stays and is superseded so it leaves recall. Nothing is deleted.",
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
    deps.derived.replaceProfile(capProfile(deps.derived.listProfile()));
  }
  return {
    remembered: true,
    factId,
    pinned: aboutJohn,
    sourceTurn: fact.sourceTurn,
  };
}

async function forgetFact(
  deps: MemoryToolDeps,
  input: ForgetInput,
): Promise<
  | { forgotten: true; factIds: string[] }
  | { forgotten: false; reason: "not found" }
> {
  const now = deps.now();
  const matches = await factsToForget(deps, input, now);
  if (matches.length === 0) {
    return { forgotten: false, reason: "not found" };
  }
  const forgotten: string[] = [];
  for (const fact of matches) {
    const marker = tombstone(deps.ids(), fact, now);
    deps.derived.insertFact(marker);
    deps.derived.updateFact({ ...fact, supersededBy: marker.id });
    await deps.vectors.delete([fact.id]);
    dropProfileFor(deps.derived, fact);
    forgotten.push(fact.id);
  }
  return { forgotten: true, factIds: forgotten };
}

async function factsToForget(
  deps: MemoryToolDeps,
  input: ForgetInput,
  now: number,
): Promise<FactRecord[]> {
  const active = activeFacts(deps.derived, now);
  if (input.factId !== undefined) {
    const found = active.find((fact) => fact.id === input.factId);
    return found === undefined ? [] : [found];
  }
  const needle = input.text?.trim().toLowerCase() ?? "";
  if (needle.length === 0) {
    return [];
  }
  const exact = active.filter((fact) => fact.text.toLowerCase() === needle);
  if (exact.length > 0) {
    return exact;
  }
  const partial = active.filter((fact) =>
    fact.text.toLowerCase().includes(needle),
  );
  if (partial.length > 0) {
    return partial;
  }
  const nearest = await nearestActive(deps, input.text ?? "", now);
  if (nearest !== null && nearest.distance <= FORGET_DISTANCE) {
    return [nearest.fact];
  }
  return [];
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
  const embedding = await deps.embedder.embed(text);
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
  const embedding = await deps.embedder.embed(fact.text);
  await deps.vectors.upsert("vec_facts", fact.id, embedding);
}

export function tombstone(
  id: string,
  fact: FactRecord,
  now: number,
): FactRecord {
  return {
    id,
    text: `Forgotten: ${fact.text}`,
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
  const next = derived.listProfile().filter((row) => {
    if (row.value === fact.text) {
      return false;
    }
    return !(
      row.pinned &&
      fact.sourceTurn !== null &&
      row.sourceTurn === fact.sourceTurn
    );
  });
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
