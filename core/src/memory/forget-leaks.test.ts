import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { randomIds } from "./derived.ts";
import { FakeEmbedder } from "./embedder.ts";
import { HybridRetriever } from "./hybrid-retrieve.ts";
import { ContentIndexer } from "./index-content.ts";
import { LocalReflector, renderReflectPrompt } from "./reflect-job.ts";
import { createMemoryRuntime } from "./runtime.ts";
import { localDay } from "./schedule.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import { SqliteVecIndex } from "./sqlite-vec-index.ts";
import { MEMORY_FORGET_TOOL, MEMORY_REMEMBER_TOOL } from "./tools.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const toolOptions = {
  toolCallId: "call-1",
  messages: [],
  context: undefined as never,
};

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-forget-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function vector(): Float32Array {
  const row = new Float32Array(EMBEDDING_DIMENSIONS);
  row[0] = 1;
  return row;
}

describe("forget leaks", () => {
  it("drops the assistant echo, the forget request, and its reply", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 5_000 });
    const vectors = new SqliteVecIndex(store.database());
    const prompts: string[] = [];
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors,
      now: () => 5_000,
      recordTurns: false,
      log: () => undefined,
      complete: async (args) => {
        prompts.push(args.prompt);
        return JSON.stringify({
          journal: "Weather.",
          summary: "Weather",
          facts: [],
          profile: [],
        });
      },
    });
    const log = new ChatLog(store, null, null);
    await log.messagesFor("conv", "remember my locker code is 4417");
    const stated = log.currentUserTurnId();
    expect(stated).toBe("conv-1-user");
    runtime.host.noteUserTurn?.(stated ?? "");
    await runtime.host.tools[MEMORY_REMEMBER_TOOL]?.execute?.(
      { text: "locker code 4417", kind: "event", aboutJohn: true },
      toolOptions,
    );
    log.commit({
      conversationId: "conv",
      userText: "remember my locker code is 4417",
      assistantText: "Saved: your locker code is 4417.",
      modelId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
    await log.messagesFor("conv", "Forget that code");
    const request = log.currentUserTurnId();
    expect(request).toBe("conv-3-user");
    runtime.host.noteUserTurn?.(request ?? "");
    const dropped = await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    expect(dropped).toMatchObject({ forgotten: true });
    log.commit({
      conversationId: "conv",
      userText: "Forget that code",
      assistantText: "Done. I forgot the locker code 4417.",
      modelId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
    await log.messagesFor("conv", "what is the weather");
    log.commit({
      conversationId: "conv",
      userText: "what is the weather",
      assistantText: "It is sunny.",
      modelId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });

    expect(store.forgottenTurnIds()).toEqual([
      "conv-1-user",
      "conv-2-assistant",
      "conv-3-user",
      "conv-4-assistant",
    ]);
    expect(store.summary("conv") ?? "").not.toContain("4417");
    const visible = store
      .recentTurns("conv", 20)
      .filter((turn) => !store.forgottenTurnIds().includes(turn.id));
    expect(
      renderReflectPrompt("conv", visible, store.listFacts()),
    ).not.toContain("4417");
    const reflector = new LocalReflector({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors,
      complete: async (args) => {
        prompts.push(args.prompt);
        return JSON.stringify({
          journal: "Weather.",
          summary: "Weather",
          facts: [],
          profile: [],
        });
      },
      now: () => 5_000,
      timeZone: "UTC",
      localDay,
      factIds: randomIds("fact"),
      journalIds: randomIds("journal"),
    });
    await reflector.reflect("conv");
    expect(prompts.join("\n")).not.toContain("4417");
    expect(prompts.join("\n")).toContain("weather");
    const hits = await new HybridRetriever({
      db: store.database(),
      vectors,
      embedder: new FakeEmbedder(),
      store,
      available: async () => false,
    }).retrieve("4417");
    expect(hits.map((hit) => hit.text).join("\n")).not.toContain("4417");
    expect(
      store
        .recentTurns("conv", 20)
        .some((turn) => turn.content.includes("4417")),
    ).toBe(true);
    runtime.scheduler.stop();
    store.close();
  });

  it("drops a reflect profile row whose value is the key", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "remember my locker code is 4417",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const reflector = new LocalReflector({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      complete: async () =>
        JSON.stringify({
          journal: "John mentioned a locker.",
          summary: "Locker",
          facts: [
            {
              text: "locker code is 4417",
              kind: "event",
              subject: null,
              confidence: 0.9,
              sensitive: true,
              validUntil: null,
              sourceTurn: "t1",
              contradicts: null,
            },
          ],
          profile: [
            {
              key: "locker",
              value: "4417",
              statedByJohn: true,
              stable: true,
              sessionsObserved: 1,
              shareable: false,
              sensitive: true,
              pinned: true,
            },
          ],
        }),
      now: () => 10,
      timeZone: "UTC",
      localDay,
      factIds: randomIds("fact"),
      journalIds: randomIds("journal"),
    });
    await reflector.reflect("ses-1");
    const row = store.listProfile().find((item) => item.key === "locker");
    expect(row?.value).toBe("4417");
    expect(row?.sourceTurn).toBeNull();
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      now: () => 10,
      recordTurns: false,
      log: () => undefined,
    });
    runtime.host.noteUserTurn?.("t1");
    const dropped = await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    expect(dropped).toMatchObject({ forgotten: true });
    expect(
      store.listProfile().some((item) => item.value.includes("4417")),
    ).toBe(false);
    runtime.scheduler.stop();
    store.close();
  });

  it("drops a chunk when a middle turn in the span is forgotten", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    for (const [id, content, at] of [
      ["t0", "hello", 1],
      ["tMid", "remember my locker code is 4417", 2],
      ["tEnd", "bye", 3],
    ] as const) {
      store.appendTurn({
        id,
        sessionId: "ses-1",
        role: "user",
        content,
        tainted: false,
        model: null,
        egress: false,
        escalatedFrom: null,
        tokensIn: null,
        tokensCached: null,
        tokensOut: null,
        costUsd: null,
        latencyMs: null,
        createdAt: at,
      });
    }
    store.upsertChunk({
      chunkId: "span",
      sessionId: "ses-1",
      firstTurn: "t0",
      lastTurn: "tEnd",
      text: "hello bye",
    });
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      now: () => 10,
      recordTurns: false,
      log: () => undefined,
    });
    runtime.host.noteUserTurn?.("tMid");
    await runtime.host.tools[MEMORY_REMEMBER_TOOL]?.execute?.(
      { text: "locker code 4417", kind: "event" },
      toolOptions,
    );
    await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    expect(store.listChunks().map((chunk) => chunk.chunkId)).toEqual([]);
    runtime.scheduler.stop();
    store.close();
  });

  it("deletes sqlite-vec rows when the embedder is fake", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    const vectors = new SqliteVecIndex(store.database());
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "remember my locker code is 4417",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors,
      now: () => 10,
      recordTurns: false,
      log: () => undefined,
    });
    runtime.host.noteUserTurn?.("t1");
    const remembered = await runtime.host.tools[
      MEMORY_REMEMBER_TOOL
    ]?.execute?.({ text: "locker code 4417", kind: "event" }, toolOptions);
    const factId =
      remembered &&
      typeof remembered === "object" &&
      "factId" in remembered &&
      typeof remembered.factId === "string"
        ? remembered.factId
        : "";
    await vectors.upsert("vec_facts", factId, vector());
    await vectors.upsert("vec_chunks", "chunk-4417", vector());
    store.upsertChunk({
      chunkId: "chunk-4417",
      sessionId: "ses-1",
      firstTurn: "t1",
      lastTurn: "t1",
      text: "locker code 4417",
    });
    expect(await vectors.has("vec_facts", factId)).toBe(true);
    await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    expect(
      store.database().prepare("SELECT count(*) AS n FROM vec_facts").get(),
    ).toEqual({ n: 0 });
    expect(
      store.database().prepare("SELECT count(*) AS n FROM vec_chunks").get(),
    ).toEqual({ n: 0 });
    runtime.scheduler.stop();
    store.close();
  });

  it("does not re-index a forgotten turn that has no embed row", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "remember my locker code is 4417",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const vectors = new SqliteVecIndex(store.database());
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors,
      now: () => 10,
      recordTurns: false,
      log: () => undefined,
    });
    runtime.host.noteUserTurn?.("t1");
    await runtime.host.tools[MEMORY_REMEMBER_TOOL]?.execute?.(
      { text: "locker code 4417", kind: "event" },
      toolOptions,
    );
    await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    const indexer = new ContentIndexer({
      db: store.database(),
      embedder: new FakeEmbedder(),
      vectors,
      available: async () => true,
    });
    const stats = await indexer.indexPending();
    expect(stats.turns).toBe(0);
    expect(
      store
        .database()
        .prepare("SELECT count(*) AS n FROM embed_index WHERE source = 'turn'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      store.database().prepare("SELECT count(*) AS n FROM vec_chunks").get(),
    ).toEqual({ n: 0 });
    runtime.scheduler.stop();
    store.close();
  });

  it("deletes an expired copy and a tombstone that still holds the text", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 50 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "gym locker code 4417",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    store.insertFact({
      id: "marker",
      text: "Expired: gym locker code 4417",
      kind: "event",
      subject: "memory:tombstone",
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: "t1",
      createdAt: 3,
      lastUsedAt: null,
    });
    store.insertFact({
      id: "old",
      text: "gym locker code 4417",
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: 1,
      supersededBy: "marker",
      sourceTurn: "t1",
      createdAt: 4,
      lastUsedAt: null,
    });
    store.insertFact({
      id: "live",
      text: "gym locker code 4417",
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: "t1",
      createdAt: 5,
      lastUsedAt: null,
    });
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      now: () => 50,
      recordTurns: false,
      log: () => undefined,
    });
    const dropped = await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "4417" },
      toolOptions,
    );
    expect(dropped).toMatchObject({ forgotten: true });
    expect(store.listFacts()).toEqual([]);
    const fts = store
      .database()
      .prepare("SELECT text FROM facts_fts WHERE facts_fts MATCH ?")
      .all("4417") as Array<{ text: string }>;
    expect(fts).toEqual([]);
    const hits = await new HybridRetriever({
      db: store.database(),
      vectors: new SqliteVecIndex(store.database()),
      embedder: new FakeEmbedder(),
      store,
      available: async () => false,
    }).retrieve("4417");
    expect(hits).toEqual([]);
    runtime.scheduler.stop();
    store.close();
  });

  it("forgets when the recorded turn id is not in turns", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.insertFact({
      id: "fact-1",
      text: "locker code 4417",
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: null,
      createdAt: 2,
      lastUsedAt: null,
    });
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      now: () => 10,
      recordTurns: false,
      log: () => undefined,
    });
    runtime.host.noteUserTurn?.("missing-turn");
    const dropped = await runtime.host.tools[MEMORY_FORGET_TOOL]?.execute?.(
      { factId: "fact-1" },
      toolOptions,
    );
    expect(dropped).toMatchObject({ forgotten: true, factIds: ["fact-1"] });
    expect(store.factById("fact-1")).toBeNull();
    expect(store.forgottenTurnIds()).toEqual(["missing-turn"]);
    runtime.scheduler.stop();
    store.close();
  });

  it("rolls back reflect when the summary write throws", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "The ECE midterm is Friday",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const reflector = new LocalReflector({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(store.database()),
      complete: async () =>
        JSON.stringify({
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
        }),
      now: () => 10,
      timeZone: "UTC",
      localDay,
      factIds: randomIds("fact"),
      journalIds: randomIds("journal"),
    });
    store.setSummary = () => {
      throw new Error("summary failed");
    };
    await expect(reflector.reflect("ses-1")).rejects.toThrow(/summary failed/);
    expect(store.listFacts()).toEqual([]);
    expect(store.listJournal()).toEqual([]);
    expect(store.summary("ses-1")).toBeNull();
    store.close();
  });

  it("keeps a new journal id after the database is reopened", async () => {
    const path = tempDbPath();
    const first = SqliteMemoryStore.open(path, { now: () => 10 });
    first.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    first.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "The ECE midterm is Friday",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const extraction = JSON.stringify({
      journal: "John said the ECE midterm is Friday.",
      summary: "ECE midterm Friday",
      facts: [],
      profile: [],
    });
    const reflect = (target: SqliteMemoryStore) =>
      new LocalReflector({
        store: target,
        derived: target,
        embedder: new FakeEmbedder(),
        vectors: new SqliteVecIndex(target.database()),
        complete: async () => extraction,
        now: () => 10,
        timeZone: "UTC",
        localDay,
        factIds: randomIds("fact"),
        journalIds: randomIds("journal"),
      });
    await reflect(first).reflect("ses-1");
    const firstId = first.listJournal("ses-1")[0]?.id ?? "";
    expect(firstId).toMatch(/^journal-/);
    first.close();

    const second = SqliteMemoryStore.open(path, { now: () => 20 });
    second.appendSession({
      id: "ses-2",
      surface: "popup",
      startedAt: 3,
      endedAt: null,
      summary: null,
    });
    second.appendTurn({
      id: "t2",
      sessionId: "ses-2",
      role: "user",
      content: "The bus stop is on Oak Street",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 4,
    });
    await reflect(second).reflect("ses-2");
    const ids = second.listJournal().map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("journal-"))).toBe(true);
    second.close();
  });

  it("re-embeds a turn after clearDerived drops its embed_index row", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses-1",
      role: "user",
      content: "The ECE midterm is Friday",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    const vectors = new SqliteVecIndex(store.database());
    const indexer = new ContentIndexer({
      db: store.database(),
      embedder: new FakeEmbedder(),
      vectors,
      available: async () => true,
    });
    expect((await indexer.indexPending()).turns).toBe(1);
    store.clearDerived();
    expect(
      store
        .database()
        .prepare("SELECT count(*) AS n FROM embed_index WHERE source = 'turn'")
        .get(),
    ).toEqual({ n: 0 });
    expect((await indexer.indexPending()).turns).toBe(1);
    store.close();
  });
});
