import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AgentCore } from "../agent-core.ts";
import { createAiSdkProvider } from "../model/ai-sdk-provider.ts";
import { DEFAULT_MODEL_ID } from "../protocol/types.ts";
import { isRecord } from "../protocol/validate.ts";
import { LocalConsolidator } from "./consolidate-job.ts";
import {
  type FactRecord,
  InMemoryDerivedMemory,
  sequentialIds,
} from "./derived.ts";
import { type Embedder, FakeEmbedder } from "./embedder.ts";
import { activeFacts, withoutSuperseded } from "./policy.ts";
import { capProfile, profileTokens } from "./profile-cap.ts";
import { InMemoryReflector } from "./reflect.ts";
import {
  LocalReflector,
  parseReflectExtraction,
  type ReflectExtraction,
  rebuildDerivedMemory,
  renderReflectPrompt,
  selectReflectContext,
  type TextComplete,
} from "./reflect-job.ts";
import { InMemoryRetriever } from "./retrieve.ts";
import { createMemoryRuntime, userTurnId } from "./runtime.ts";
import {
  CONSOLIDATION_DAY_META,
  DEFAULT_REFLECT_IDLE_MS,
  IdleScheduler,
  localDay,
  m1AcPower,
  readReflectIdleMs,
} from "./schedule.ts";
import { abortError, ModelSlot, type TimerQueue } from "./slot.ts";
import { InMemoryMemoryStore } from "./store.ts";
import {
  createMemoryTools,
  MEMORY_FORGET_TOOL,
  MEMORY_REMEMBER_TOOL,
  type MemoryToolState,
} from "./tools.ts";
import {
  EMBEDDING_DIMENSIONS,
  type SessionRecord,
  type TurnRecord,
} from "./types.ts";
import { InMemoryVectorIndex } from "./vectors.ts";

const DAY = Date.UTC(2026, 9, 25, 15);

function session(id: string): SessionRecord {
  return {
    id,
    surface: "popup",
    startedAt: DAY,
    endedAt: null,
    summary: null,
  };
}

function turn(
  id: string,
  content: string,
  createdAt = DAY,
  tainted = false,
): TurnRecord {
  return {
    id,
    sessionId: "ses-1",
    role: "user",
    content,
    tainted,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: 0,
    latencyMs: null,
    createdAt,
  };
}

function fact(
  partial: Partial<FactRecord> & Pick<FactRecord, "id" | "text">,
): FactRecord {
  return {
    kind: "event",
    subject: null,
    confidence: 0.9,
    sensitive: false,
    validUntil: null,
    supersededBy: null,
    sourceTurn: "t1",
    createdAt: DAY,
    lastUsedAt: null,
    ...partial,
  };
}

class ManualClock {
  nowMs = DAY;
  private readonly items: Array<{
    at: number;
    fn: () => void;
    cleared: boolean;
  }> = [];

  readonly queue: TimerQueue = {
    set: (delayMs, fn) => {
      const item = { at: this.nowMs + delayMs, fn, cleared: false };
      this.items.push(item);
      return {
        clear() {
          item.cleared = true;
        },
      };
    },
  };

  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.items.filter(
      (item) => !item.cleared && item.at <= this.nowMs,
    );
    for (const item of due) {
      item.cleared = true;
    }
    for (const item of due) {
      item.fn();
    }
  }
}

function extraction(overrides: Partial<ReflectExtraction> = {}): string {
  return JSON.stringify({
    journal: "John said the ECE midterm is Friday.",
    summary: "ECE midterm Friday",
    facts: [
      {
        text: "ECE midterm is Friday",
        kind: "event",
        subject: null,
        confidence: 0.9,
        sensitive: false,
        validUntil: null,
        sourceTurn: "t1",
        contradicts: null,
      },
    ],
    profile: [],
    ...overrides,
  });
}

function scripted(body: string): TextComplete {
  return async ({ signal }) => {
    if (signal.aborted) {
      throw abortError();
    }
    return body;
  };
}

function harness(complete: TextComplete = scripted(extraction())) {
  const store = new InMemoryMemoryStore();
  const derived = new InMemoryDerivedMemory();
  const vectors = new InMemoryVectorIndex();
  const embedder = new FakeEmbedder();
  store.appendSession(session("ses-1"));
  store.appendTurn(turn("t1", "The ECE midterm is Friday"));
  const reflector = new LocalReflector({
    store,
    derived,
    embedder,
    vectors,
    complete,
    now: () => DAY,
    timeZone: "UTC",
    localDay,
    factIds: sequentialIds("fact"),
    journalIds: sequentialIds("journal"),
  });
  return { store, derived, vectors, embedder, reflector };
}

const toolOptions = {
  toolCallId: "call-1",
  messages: [],
  context: undefined as never,
};

describe("memory.remember and memory.forget", () => {
  it("stores a pinned fact and forget hard-deletes that fact only", async () => {
    const derived = new InMemoryDerivedMemory();
    const vectors = new InMemoryVectorIndex();
    const embedder = new FakeEmbedder();
    const state: MemoryToolState = { sourceTurnId: "t1" };
    const store = new InMemoryMemoryStore();
    store.appendSession(session("ses-1"));
    store.appendTurn(turn("t1", "The ECE midterm is Friday"));
    const tools = createMemoryTools({
      derived,
      store,
      embedder,
      vectors,
      state,
      now: () => DAY,
      ids: sequentialIds("fact"),
    });
    const remember = tools[MEMORY_REMEMBER_TOOL];
    const forget = tools[MEMORY_FORGET_TOOL];
    expect(remember?.execute).toBeTypeOf("function");
    expect(forget?.execute).toBeTypeOf("function");
    const stored = await remember?.execute?.(
      {
        text: "ECE midterm is Friday",
        kind: "event",
        aboutJohn: true,
        profileKey: "ece_midterm",
      },
      toolOptions,
    );
    expect(stored).toEqual({
      remembered: true,
      factId: "fact-1",
      pinned: true,
      sourceTurn: "t1",
    });
    expect(derived.listProfile()).toEqual([
      expect.objectContaining({
        key: "ece_midterm",
        pinned: true,
        sourceTurn: "t1",
        value: "ECE midterm is Friday",
      }),
    ]);

    const retriever = new InMemoryRetriever();
    retriever.add({
      id: "fact-1",
      text: "ECE midterm is Friday",
      source: "fact",
    });
    const retrieve = withoutSuperseded(retriever.retrieve, derived, () => DAY);
    await expect(retrieve("midterm")).resolves.toEqual([
      { id: "fact-1", text: "ECE midterm is Friday", source: "fact" },
    ]);

    const embedding = await embedder.embed("ECE midterm is Friday");
    expect(
      (await vectors.knn("vec_facts", embedding, 4)).map((hit) => hit.id),
    ).toContain("fact-1");
    derived.upsertProfile({
      key: "linked",
      value: "something else",
      pinned: true,
      shareable: true,
      sourceTurn: "t1",
      updatedAt: DAY,
    });
    derived.upsertProfile({
      key: "kept",
      value: "leave this",
      pinned: false,
      shareable: true,
      sourceTurn: null,
      updatedAt: DAY,
    });
    derived.insertFact(
      fact({
        id: "fact-sibling",
        text: "gym locker is near the door",
        sourceTurn: "t1",
      }),
    );
    derived.upsertChunk({
      chunkId: "chunk-1",
      sessionId: "ses-1",
      firstTurn: "t1",
      lastTurn: "t1",
      text: "user: The ECE midterm is Friday",
    });
    await vectors.upsert("vec_chunks", "chunk-1", embedding);

    const dropped = await forget?.execute?.({ text: "midterm" }, toolOptions);
    expect(dropped).toEqual({ forgotten: true, factIds: ["fact-1"] });
    expect(
      (await vectors.knn("vec_facts", embedding, 4)).map((hit) => hit.id),
    ).not.toContain("fact-1");
    expect(
      (await vectors.knn("vec_chunks", embedding, 4)).map((hit) => hit.id),
    ).not.toContain("chunk-1");
    expect(derived.factById("fact-1")).toBeNull();
    expect(derived.factById("fact-sibling")?.text).toBe(
      "gym locker is near the door",
    );
    expect(
      derived.listFacts().some((row) => /forgotten|midterm/i.test(row.text)),
    ).toBe(false);
    expect(derived.forgottenTurnIds()).toEqual(["t1"]);
    expect(derived.listChunks()).toEqual([]);
    expect(
      derived
        .listProfile()
        .map((row) => row.key)
        .sort(),
    ).toEqual(["kept", "linked"]);
    await expect(retrieve("midterm")).resolves.toEqual([]);
  });

  it("returns candidates when several facts match and none is exact", async () => {
    const derived = new InMemoryDerivedMemory();
    const store = new InMemoryMemoryStore();
    const tools = createMemoryTools({
      derived,
      store,
      embedder: new FakeEmbedder(),
      vectors: new InMemoryVectorIndex(),
      state: { sourceTurnId: "t1" },
      now: () => DAY,
      ids: sequentialIds("fact"),
    });
    derived.insertFact(fact({ id: "a", text: "alpha midterm notes" }));
    derived.insertFact(fact({ id: "b", text: "beta midterm notes" }));
    const short = await tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "mid" },
      toolOptions,
    );
    expect(short).toEqual({ forgotten: false, reason: "too short" });
    expect(derived.factById("a")).not.toBeNull();
    const ambiguous = await tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "midterm" },
      toolOptions,
    );
    expect(ambiguous).toMatchObject({ forgotten: false, reason: "ambiguous" });
    expect(derived.listFacts()).toHaveLength(2);
    derived.insertFact(fact({ id: "exact", text: "midterm notes" }));
    const exact = await tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "midterm notes" },
      toolOptions,
    );
    expect(exact).toMatchObject({
      forgotten: true,
      factIds: ["exact"],
      candidates: [
        { id: "a", text: "alpha midterm notes" },
        { id: "b", text: "beta midterm notes" },
      ],
    });
    expect(derived.factById("exact")).toBeNull();
    expect(derived.factById("a")).not.toBeNull();
    expect(derived.factById("b")).not.toBeNull();
  });

  it("refuses a secret and does not write a fact", async () => {
    const derived = new InMemoryDerivedMemory();
    const state: MemoryToolState = { sourceTurnId: "t1" };
    const tools = createMemoryTools({
      derived,
      store: new InMemoryMemoryStore(),
      embedder: new FakeEmbedder(),
      vectors: new InMemoryVectorIndex(),
      state,
      now: () => DAY,
      ids: sequentialIds("fact"),
    });
    const result = await tools[MEMORY_REMEMBER_TOOL]?.execute?.(
      {
        text: "api_key=supersecretvalue",
        kind: "preference",
        aboutJohn: true,
      },
      toolOptions,
    );
    expect(result).toEqual({ remembered: false, reason: "secret" });
    expect(derived.listFacts()).toEqual([]);
  });
});

describe("reflect job", () => {
  it("writes one journal entry and a fact that cites the source turn", async () => {
    const { derived, reflector } = harness();
    await reflector.reflect("ses-1");
    await reflector.reflect("ses-1");
    expect(derived.listJournal("ses-1")).toEqual([
      expect.objectContaining({
        day: "2026-10-25",
        entry: "John said the ECE midterm is Friday.",
        sessionId: "ses-1",
      }),
    ]);
    expect(derived.summary("ses-1")).toBe("ECE midterm Friday");
    const facts = activeFacts(derived, DAY);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual(
      expect.objectContaining({
        text: "ECE midterm is Friday",
        sourceTurn: "t1",
      }),
    );
  });

  it("supersedes a contradiction and skips a duplicate", async () => {
    const { derived, reflector } = harness(
      scripted(
        extraction({
          facts: [
            {
              text: "ECE midterm is Thursday",
              kind: "event",
              subject: null,
              confidence: 0.95,
              sensitive: false,
              validUntil: null,
              sourceTurn: "t1",
              contradicts: "old",
            },
          ],
        }),
      ),
    );
    derived.insertFact(fact({ id: "old", text: "ECE midterm is Friday" }));
    await reflector.reflect("ses-1");
    expect(derived.factById("old")?.supersededBy).toBe("fact-1");
    expect(activeFacts(derived, DAY).map((row) => row.text)).toEqual([
      "ECE midterm is Thursday",
    ]);

    const again = harness(
      scripted(
        extraction({
          facts: [
            {
              text: "ECE midterm is Friday",
              kind: "event",
              subject: null,
              confidence: 0.9,
              sensitive: false,
              validUntil: null,
              sourceTurn: "t1",
              contradicts: null,
            },
            {
              text: "ECE midterm is Friday",
              kind: "event",
              subject: null,
              confidence: 0.9,
              sensitive: false,
              validUntil: null,
              sourceTurn: "t1",
              contradicts: null,
            },
          ],
        }),
      ),
    );
    await again.reflector.reflect("ses-1");
    expect(activeFacts(again.derived, DAY)).toHaveLength(1);
  });

  it("drops secrets, verbatim screen text, and unknown source turns", async () => {
    const { store, derived, reflector } = harness(
      scripted(
        extraction({
          facts: [
            {
              text: "password=hunter2hunter",
              kind: "preference",
              subject: null,
              confidence: 1,
              sensitive: true,
              validUntil: null,
              sourceTurn: "t1",
              contradicts: null,
            },
            {
              text: "x".repeat(60),
              kind: "event",
              subject: null,
              confidence: 0.8,
              sensitive: false,
              validUntil: null,
              sourceTurn: "screen",
              contradicts: null,
            },
            {
              text: "Office hours are Tuesday",
              kind: "event",
              subject: null,
              confidence: 0.8,
              sensitive: false,
              validUntil: null,
              sourceTurn: "missing",
              contradicts: null,
            },
          ],
        }),
      ),
    );
    store.appendTurn(turn("screen", `notes ${"x".repeat(60)} end`, DAY, true));
    await reflector.reflect("ses-1");
    expect(activeFacts(derived, DAY)).toEqual([]);
  });

  it("promotes profile rows only when John stated them or they repeat", async () => {
    const { derived, reflector } = harness(
      scripted(
        extraction({
          facts: [],
          profile: [
            {
              key: "school",
              value: "ECE",
              statedByJohn: true,
              stable: true,
              sessionsObserved: 1,
              shareable: true,
              sensitive: false,
              pinned: true,
            },
            {
              key: "guess",
              value: "maybe",
              statedByJohn: false,
              stable: false,
              sessionsObserved: 1,
              shareable: true,
              sensitive: false,
              pinned: false,
            },
            {
              key: "habit",
              value: "walks at noon",
              statedByJohn: false,
              stable: false,
              sessionsObserved: 3,
              shareable: true,
              sensitive: false,
              pinned: false,
            },
          ],
        }),
      ),
    );
    await reflector.reflect("ses-1");
    expect(derived.listProfile().map((row) => [row.key, row.pinned])).toEqual([
      ["habit", false],
      ["school", true],
    ]);
  });

  it("rebuilds derived rows from turns", async () => {
    const { derived, reflector, vectors, embedder } = harness();
    await reflector.reflect("ses-1");
    expect(activeFacts(derived, DAY)).toHaveLength(1);
    const firstId = activeFacts(derived, DAY)[0]?.id ?? "";
    const embedding = await embedder.embed("ECE midterm is Friday");
    expect(
      (await vectors.knn("vec_facts", embedding, 4)).map((hit) => hit.id),
    ).toContain(firstId);
    await rebuildDerivedMemory({
      sessionIds: ["ses-1"],
      derived,
      vectors,
      reflect: (sessionId) => reflector.reflect(sessionId),
    });
    expect(
      (await vectors.knn("vec_facts", embedding, 4)).map((hit) => hit.id),
    ).not.toContain(firstId);
    expect(derived.listJournal("ses-1")).toHaveLength(1);
    expect(activeFacts(derived, DAY)).toHaveLength(1);
    expect(activeFacts(derived, DAY)[0]?.sourceTurn).toBe("t1");
  });

  it("writes facts and the summary when the signal aborts after the model returns", async () => {
    const controller = new AbortController();
    const { derived, reflector } = harness(async () => {
      controller.abort();
      return extraction();
    });
    await reflector.reflect("ses-1", { signal: controller.signal });
    expect(derived.summary("ses-1")).toBe("ECE midterm Friday");
    expect(activeFacts(derived, DAY)).toHaveLength(1);
    expect(derived.listJournal("ses-1")).toHaveLength(1);
  });

  it("does not mark reflect done when the model itself aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { derived, reflector } = harness(async ({ signal }) => {
      if (signal.aborted) {
        throw abortError();
      }
      return extraction();
    });
    await expect(
      reflector.reflect("ses-1", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(derived.summary("ses-1")).toBeNull();
    expect(derived.listFacts()).toEqual([]);
  });

  it("caps the reflect prompt at about 6k tokens of recent turns", () => {
    const turns = Array.from({ length: 80 }, (_, index) =>
      turn(`t-${index}`, "x".repeat(800), DAY + index),
    );
    const selected = selectReflectContext(turns, []);
    expect(selected.turns.length).toBeLessThan(turns.length);
    expect(selected.turns[0]?.id).not.toBe("t-0");
    expect(selected.turns.at(-1)?.id).toBe("t-79");
    const prompt = renderReflectPrompt("ses-1", turns, []);
    expect(prompt).toContain("id=t-79");
    expect(prompt).not.toContain("id=t-0");
  });

  it("rejects a model reply that is not JSON", async () => {
    const { reflector } = harness(scripted("not json"));
    await expect(reflector.reflect("ses-1")).rejects.toThrow();
  });

  it("parses a fenced JSON object", () => {
    const parsed = parseReflectExtraction(
      '```json\n{"journal":"Hi.","summary":"Hi"}\n```',
    );
    expect(parsed.journal).toBe("Hi.");
    expect(parsed.facts).toEqual([]);
  });
});

describe("consolidation", () => {
  it("expires, merges, caps the profile, rechunks today's turns, and compacts", async () => {
    const derived = new InMemoryDerivedMemory();
    const vectors = new InMemoryVectorIndex();
    const embedder = new NearEmbedder();
    const store = new InMemoryMemoryStore();
    store.appendSession(session("ses-1"));
    store.appendSession(session("ses-old"));
    store.appendTurn(turn("today", "packed the bag", DAY));
    store.appendTurn(turn("yesterday", "old note", DAY - 86_400_000));
    store.appendTurn({
      ...turn("older", "kept chunk", DAY - 86_400_000),
      sessionId: "ses-old",
    });
    derived.insertFact(
      fact({
        id: "fresh",
        text: "alpha",
        validUntil: DAY + 86_400_000,
        createdAt: DAY,
        confidence: 0.4,
      }),
    );
    derived.insertFact(
      fact({
        id: "copy",
        text: "alpha-near",
        createdAt: DAY + 1,
        confidence: 0.9,
      }),
    );
    derived.insertFact(
      fact({
        id: "stale",
        text: "beta",
        validUntil: DAY - 1,
        createdAt: DAY,
      }),
    );
    await embedFactText(embedder, vectors, "fresh", "alpha");
    await embedFactText(embedder, vectors, "copy", "alpha-near");
    await embedFactText(embedder, vectors, "stale", "beta");
    derived.upsertChunk({
      chunkId: "chunk-ses-1-stale-today",
      sessionId: "ses-1",
      firstTurn: "today",
      lastTurn: "today",
      text: "stale today chunk",
    });
    derived.upsertChunk({
      chunkId: "chunk-ses-1-yesterday",
      sessionId: "ses-1",
      firstTurn: "yesterday",
      lastTurn: "yesterday",
      text: "old note",
    });
    derived.upsertChunk({
      chunkId: "chunk-ses-old-0",
      sessionId: "ses-old",
      firstTurn: "older",
      lastTurn: "older",
      text: "kept chunk",
    });
    await vectors.upsert(
      "vec_chunks",
      "chunk-ses-1-stale-today",
      staleVector(),
    );
    await vectors.upsert("vec_chunks", "chunk-ses-1-yesterday", oldVector());
    derived.upsertProfile({
      key: "name",
      value: "John",
      pinned: true,
      shareable: true,
      sourceTurn: "today",
      updatedAt: 1,
    });
    for (let index = 0; index < 40; index += 1) {
      derived.upsertProfile({
        key: `note_${index}`,
        value: "x".repeat(200),
        pinned: false,
        shareable: true,
        sourceTurn: null,
        updatedAt: index,
      });
    }
    let compacted = 0;
    const job = new LocalConsolidator({
      derived,
      embedder,
      vectors,
      sessionIds: () => ["ses-1", "ses-old"],
      readTurns: (sessionId) => store.recentTurns(sessionId, 100),
      now: () => DAY,
      timeZone: "UTC",
      localDay,
      ids: sequentialIds("marker"),
      maintenance: {
        async optimizeAndBackup() {
          compacted += 1;
        },
      },
    });
    await job.consolidate();
    expect(derived.factById("stale")?.supersededBy).toMatch(/^marker-/);
    const staleMarker = derived.factById(
      derived.factById("stale")?.supersededBy ?? "",
    );
    expect(staleMarker?.text).toBe("Superseded stale");
    expect(staleMarker?.text).not.toContain("beta");
    const freshMarker = derived.factById(
      derived.factById("fresh")?.supersededBy ?? "",
    );
    expect(freshMarker?.text ?? "").not.toContain("alpha");
    expect(activeFacts(derived, DAY).map((row) => row.id)).toEqual(["copy"]);
    expect(derived.factById("fresh")?.supersededBy).toMatch(/^marker-/);
    expect(
      profileTokens(capProfile(derived.listProfile())),
    ).toBeLessThanOrEqual(800);
    expect(
      derived.listProfile().some((row) => row.key.startsWith("note_")),
    ).toBe(true);
    expect(
      derived.listProfile().some((row) => row.key === "name" && row.pinned),
    ).toBe(true);
    const chunks = derived.listChunks("ses-1");
    const chunkText = chunks.map((chunk) => chunk.text).join("\n");
    expect(chunkText).toContain("packed the bag");
    expect(chunkText).toContain("old note");
    expect(derived.listChunks("ses-old").map((chunk) => chunk.text)).toEqual([
      "kept chunk",
    ]);
    const staleHits = await vectors.knn("vec_chunks", staleVector(), 4);
    expect(staleHits.map((hit) => hit.id)).not.toContain(
      "chunk-ses-1-stale-today",
    );
    const oldHits = await vectors.knn("vec_chunks", oldVector(), 4);
    expect(oldHits.map((hit) => hit.id)).toContain("chunk-ses-1-yesterday");
    const first = chunks[0];
    expect(first).toBeDefined();
    const hits = await vectors.knn(
      "vec_chunks",
      await embedder.embed(first?.text ?? ""),
      1,
    );
    expect(hits[0]?.id).toBe(first?.chunkId);
    expect(compacted).toBe(1);
  });

  it("rechunks a session recorded before this process", async () => {
    const store = new InMemoryMemoryStore();
    const derived = new InMemoryDerivedMemory();
    store.appendSession(session("ses-1"));
    store.appendTurn(turn("old-turn", "packed the bag"));
    const runtime = createMemoryRuntime({
      store,
      derived,
      now: () => DAY,
      idleMs: 1_000,
      timeZone: "UTC",
      complete: async () => extraction({ facts: [] }),
    });
    runtime.scheduler.requestConsolidation();
    await runtime.scheduler.drained();
    expect(
      derived
        .listChunks("ses-1")
        .map((chunk) => chunk.text)
        .join("\n"),
    ).toContain("packed the bag");
    runtime.scheduler.stop();
  });
});

describe("idle scheduler", () => {
  it("waits out the idle window and does not run while chat holds the slot", async () => {
    const clock = new ManualClock();
    const slot = new ModelSlot();
    const derived = new InMemoryDerivedMemory();
    let reflects = 0;
    const scheduler = new IdleScheduler({
      slot,
      derived,
      now: () => clock.nowMs,
      idleMs: 1_000,
      timeZone: "UTC",
      localDay,
      timers: clock.queue,
      reflect: async () => {
        reflects += 1;
      },
      consolidate: async () => undefined,
    });
    scheduler.onChatSettled("ses-1");
    await scheduler.drained();
    clock.advance(999);
    await scheduler.drained();
    expect(reflects).toBe(0);
    slot.chatStarted();
    scheduler.onChatStarted("ses-1");
    clock.advance(5_000);
    await scheduler.drained();
    expect(reflects).toBe(0);
    expect(slot.chatActive).toBe(true);
    slot.chatFinished();
    scheduler.onChatSettled("ses-1");
    clock.advance(1_000);
    await scheduler.drained();
    expect(reflects).toBe(1);
  });

  it("aborts an in-flight reflect when chat starts and runs it after the next idle", async () => {
    const clock = new ManualClock();
    const slot = new ModelSlot();
    const derived = new InMemoryDerivedMemory();
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const scheduler = new IdleScheduler({
      slot,
      derived,
      now: () => clock.nowMs,
      idleMs: 100,
      timeZone: "UTC",
      localDay,
      timers: clock.queue,
      reflect: async (_sessionId, signal) => {
        calls += 1;
        if (calls === 1) {
          started?.();
          await new Promise<void>((_resolve, reject) => {
            const fail = (): void => {
              reject(abortError());
            };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener("abort", fail, { once: true });
          });
        }
        derived.setMeta("reflected", "yes");
      },
      consolidate: async () => undefined,
    });
    scheduler.onChatSettled("ses-1");
    await scheduler.drained();
    clock.advance(100);
    await entered;
    slot.chatStarted();
    scheduler.onChatStarted("ses-1");
    await scheduler.drained();
    expect(derived.getMeta("reflected")).toBeNull();
    slot.chatFinished();
    scheduler.onChatSettled("ses-1");
    clock.advance(100);
    await scheduler.drained();
    expect(derived.getMeta("reflected")).toBe("yes");
  });

  it("consolidates on the first idle of a day, on demand, and not while on battery", async () => {
    const clock = new ManualClock();
    const slot = new ModelSlot();
    const derived = new InMemoryDerivedMemory();
    let runs = 0;
    let ac = true;
    const scheduler = new IdleScheduler({
      slot,
      derived,
      now: () => clock.nowMs,
      idleMs: 1_000,
      timeZone: "UTC",
      localDay,
      timers: clock.queue,
      power: { onAcPower: () => ac },
      reflect: async () => undefined,
      consolidate: async () => {
        runs += 1;
      },
    });
    expect(m1AcPower.onAcPower()).toBe(true);
    ac = false;
    scheduler.start();
    await scheduler.drained();
    expect(runs).toBe(0);
    expect(derived.getMeta(CONSOLIDATION_DAY_META)).toBeNull();
    ac = true;
    scheduler.start();
    await scheduler.drained();
    expect(runs).toBe(1);
    expect(derived.getMeta(CONSOLIDATION_DAY_META)).toBe("2026-10-25");
    scheduler.requestConsolidation();
    await scheduler.drained();
    expect(runs).toBe(2);
    clock.nowMs += 3_600_000;
    scheduler.onChatSettled("ses-1");
    await scheduler.drained();
    expect(runs).toBe(2);
    clock.nowMs += 86_400_000;
    scheduler.onChatSettled("ses-1");
    await scheduler.drained();
    expect(runs).toBe(3);
    expect(derived.getMeta(CONSOLIDATION_DAY_META)).toBe(
      localDay(clock.nowMs, "UTC"),
    );
  });

  it("does not let reflect and chat hold the slot together", async () => {
    const slot = new ModelSlot();
    let second = false;
    const first = slot.acquireIdle("reflect");
    const waiting = slot.acquireIdle("consolidate").then(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    slot.chatStarted();
    const hold = await first;
    expect(hold.signal.aborted).toBe(true);
    expect(slot.chatActive).toBe(true);
    hold.release();
    await Promise.resolve();
    expect(second).toBe(false);
    slot.chatFinished();
    await waiting;
    expect(second).toBe(true);
  });
});

describe("reflect idle defaults", () => {
  it("reads the ten minute default and a test override", () => {
    expect(DEFAULT_REFLECT_IDLE_MS).toBe(600_000);
    expect(readReflectIdleMs({})).toBe(600_000);
    expect(readReflectIdleMs({ COOKIE_REFLECT_IDLE_MS: "25" })).toBe(25);
    expect(() => readReflectIdleMs({ COOKIE_REFLECT_IDLE_MS: "nope" })).toThrow(
      /COOKIE_REFLECT_IDLE_MS/,
    );
  });

  it("keeps the step 0 reflector fake as a call log", async () => {
    const reflector = new InMemoryReflector();
    await reflector.reflect("ses-1");
    expect(reflector.calls).toEqual(["ses-1"]);
  });
});

describe("memory tools on the chat core", () => {
  it("finishes memory.remember with chat.done stop, and reflect waits until idle", async () => {
    const clock = new ManualClock();
    let reflects = 0;
    let releaseChat: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt, abortSignal }) => {
        const blob = JSON.stringify(prompt);
        if (blob.includes("tool-result")) {
          return {
            stream: simulateReadableStream({
              chunks: textChunks(["Saved."]),
            }),
          } as never;
        }
        await opened;
        if (abortSignal?.aborted) {
          throw abortError();
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-remember",
                toolName: MEMORY_REMEMBER_TOOL,
                input: JSON.stringify({
                  text: "ECE midterm is Friday",
                  kind: "event",
                  aboutJohn: true,
                  profileKey: "ece_midterm",
                }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usage(),
              },
            ],
          }),
        } as never;
      },
    });
    const provider = createAiSdkProvider({
      modelId: DEFAULT_MODEL_ID,
      model,
      probe: async () => "up",
    });
    const runtime = createMemoryRuntime({
      provider,
      idleMs: 1_000,
      timeZone: "UTC",
      timers: clock.queue,
      now: () => clock.nowMs,
      complete: async ({ prompt, signal }) => {
        if (signal.aborted) {
          throw abortError();
        }
        reflects += 1;
        const source = prompt
          .match(/id=turn-msg-\d+-user/)?.[0]
          ?.replace("id=", "");
        return extraction({
          facts: [
            {
              text: "John studies ECE",
              kind: "preference",
              subject: null,
              confidence: 0.8,
              sensitive: false,
              validUntil: null,
              sourceTurn: source ?? "missing",
              contradicts: null,
            },
          ],
        });
      },
    });
    const messages: unknown[] = [];
    const core = new AgentCore({
      provider,
      probeTimeoutMs: 200,
      now: () => clock.nowMs,
      memoryHost: runtime.host,
      emit: (message) => {
        messages.push(message);
      },
      log: () => undefined,
      exit: () => undefined,
    });
    runtime.start();
    await runtime.scheduler.drained();
    core.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "0.1",
          clientInfo: { name: "cookie-test", version: "0.0.0" },
          capabilities: { chatCancel: true },
        },
      }),
    );
    await waitFor(() =>
      messages.some(
        (message) => isRecord(message) && message.method === "runtime.status",
      ),
    );
    expect(runtime.slot.chatActive).toBe(false);
    core.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "chat.send",
        params: {
          conversationId: "conv-1",
          text: "Remember my ECE midterm is Friday",
        },
      }),
    );
    await waitFor(() => model.doStreamCalls.length > 0);
    expect(runtime.slot.chatActive).toBe(true);
    expect(model.doStreamCalls[0]?.tools?.map((entry) => entry.name)).toEqual([
      MEMORY_REMEMBER_TOOL,
      MEMORY_FORGET_TOOL,
    ]);
    clock.advance(60_000);
    await runtime.scheduler.drained();
    expect(reflects).toBe(0);
    releaseChat?.();
    await waitFor(() =>
      messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    const done = messages.find(
      (message) => isRecord(message) && message.method === "chat.done",
    );
    expect(done).toMatchObject({
      method: "chat.done",
      params: { finishReason: "stop", conversationId: "conv-1" },
    });
    expect(done).not.toMatchObject({
      params: { finishReason: "error" },
    });
    expect(runtime.slot.chatActive).toBe(false);
    const remembered = runtime.derived
      .listFacts()
      .find((row) => row.text === "ECE midterm is Friday");
    expect(remembered?.sourceTurn).toBe(userTurnId("msg-1"));
    expect(runtime.derived.listProfile()).toEqual([
      expect.objectContaining({ key: "ece_midterm", pinned: true }),
    ]);
    clock.advance(1_000);
    await runtime.scheduler.drained();
    expect(reflects).toBe(1);
    expect(runtime.derived.listJournal("conv-1")).toHaveLength(1);
    expect(
      activeFacts(runtime.derived, clock.nowMs).some(
        (row) =>
          row.text === "John studies ECE" &&
          row.sourceTurn === userTurnId("msg-1"),
      ),
    ).toBe(true);
    runtime.scheduler.stop();
  });
});

function textChunks(parts: string[]) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...parts.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
    },
  ];
}

function usage() {
  return {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  };
}

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("timed out");
}

class NearEmbedder implements Embedder {
  async embed(text: string): Promise<Float32Array> {
    const bare = text
      .replace(/^search_document: /, "")
      .replace(/^search_query: /, "");
    const out = new Float32Array(EMBEDDING_DIMENSIONS);
    if (bare === "alpha" || bare === "alpha-near") {
      out[0] = 1;
      out[1] = bare === "alpha" ? 0 : 0.02;
      return out;
    }
    if (text === "beta") {
      out[2] = 1;
      return out;
    }
    let hash = 0;
    for (let index = 0; index < bare.length; index += 1) {
      hash = (hash + bare.charCodeAt(index)) % EMBEDDING_DIMENSIONS;
    }
    out[hash] = 1;
    return out;
  }
}

function staleVector(): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMENSIONS);
  out[3] = 1;
  return out;
}

function oldVector(): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMENSIONS);
  out[4] = 1;
  return out;
}

async function embedFactText(
  embedder: Embedder,
  vectors: InMemoryVectorIndex,
  id: string,
  text: string,
): Promise<void> {
  await vectors.upsert("vec_facts", id, await embedder.embed(text));
}
