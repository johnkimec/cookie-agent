import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { randomIds } from "./derived.ts";
import { FakeEmbedder } from "./embedder.ts";
import { HybridRetriever } from "./hybrid-retrieve.ts";
import { ContentIndexer } from "./index-content.ts";
import { LocalReflector } from "./reflect-job.ts";
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

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-guard-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function setup() {
  let clock = 1_000;
  const now = () => (clock += 10);
  const store = SqliteMemoryStore.open(dbPath(), { now });
  const db = store.database();
  const vectors = new SqliteVecIndex(db);
  const embedder = new FakeEmbedder();
  const indexer = new ContentIndexer({
    db,
    embedder,
    vectors,
    now,
    available: async () => true,
  });
  const retriever = new HybridRetriever({
    db,
    vectors,
    embedder,
    store,
    available: async () => true,
  });
  const log = new ChatLog(store, indexer, retriever);
  const runtime = createMemoryRuntime({
    store,
    derived: store,
    embedder,
    vectors,
    now,
    recordTurns: false,
    log: () => undefined,
    complete: async () =>
      JSON.stringify({ journal: "", summary: "", facts: [], profile: [] }),
  });
  let reflectReply = "";
  const reflector = new LocalReflector({
    store,
    derived: store,
    embedder,
    vectors,
    complete: async () => reflectReply,
    now,
    timeZone: "UTC",
    localDay,
    factIds: randomIds("fact"),
    journalIds: randomIds("journal"),
  });
  const turn = async (
    conv: string,
    user: string,
    reply: string,
    tool?: () => Promise<unknown>,
  ) => {
    await log.messagesFor(conv, user);
    runtime.host.noteUserTurn?.(log.currentUserTurnId() ?? "");
    const out = tool ? await tool() : undefined;
    log.commit({
      conversationId: conv,
      userText: user,
      assistantText: reply,
      modelId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
    await log.flushIndex();
    return out;
  };
  const tool = (name: string, input: unknown) => () =>
    runtime.host.tools[name]?.execute?.(input as never, toolOptions);
  return {
    store,
    vectors,
    retriever,
    log,
    runtime,
    reflector,
    turn,
    tool,
    setReflect: (value: unknown) => {
      reflectReply = JSON.stringify(value);
    },
  };
}

describe("forget keeps unrelated pinned rows", () => {
  it("does not drop a name, a year, or a short count that shares a common word", async () => {
    const h = setup();
    for (const row of [
      { key: "name", value: "John", pinned: true },
      { key: "full_name", value: "John Kim", pinned: true },
      { key: "pronouns", value: "he/him", pinned: true },
      { key: "city", value: "Toronto", pinned: true },
      { key: "married", value: "married in 2026", pinned: false },
      { key: "kids", value: "2 kids", pinned: false },
      {
        key: "locker_room",
        value: "prefers the locker room near the code desk",
        pinned: false,
      },
    ]) {
      h.store.upsertProfile({
        ...row,
        shareable: true,
        sourceTurn: null,
        updatedAt: 1,
      });
    }
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "John's locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    const first = await h.tool(MEMORY_FORGET_TOOL, {
      text: "John's locker code is 4417",
    })();
    expect(first).toMatchObject({ forgotten: true });
    expect(
      h.store
        .listProfile()
        .map((row) => row.key)
        .sort(),
    ).toEqual([
      "city",
      "full_name",
      "kids",
      "locker_room",
      "married",
      "name",
      "pronouns",
    ]);
    await h.turn(
      "a",
      "remember the dentist",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "Dentist appointment at the gym on 2026-11-03 at 2 pm",
        kind: "event",
        aboutJohn: false,
      }),
    );
    const second = await h.tool(MEMORY_FORGET_TOOL, {
      text: "Dentist appointment at the gym on 2026-11-03 at 2 pm",
    })();
    expect(second).toMatchObject({ forgotten: true });
    expect(
      h.store
        .listProfile()
        .map((row) => row.key)
        .sort(),
    ).toEqual([
      "city",
      "full_name",
      "kids",
      "locker_room",
      "married",
      "name",
      "pronouns",
    ]);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("keeps a pinned name stated on the same turn as the secret", async () => {
    const h = setup();
    await h.turn(
      "a",
      "I'm John, he/him, and my locker code is 4417",
      "Nice to meet you John.",
    );
    const turnId =
      h.store.recentTurns("a", 20).find((row) => row.role === "user")?.id ??
      null;
    h.setReflect({
      journal: "Intro.",
      summary: "John introduced himself.",
      facts: [
        {
          text: "Locker code is 4417",
          kind: "event",
          subject: null,
          confidence: 0.9,
          sensitive: true,
          validUntil: null,
          sourceTurn: turnId,
          contradicts: null,
        },
      ],
      profile: [
        {
          key: "name",
          value: "John",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 3,
          shareable: true,
          sensitive: false,
          pinned: true,
        },
        {
          key: "pronouns",
          value: "he/him",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 3,
          shareable: true,
          sensitive: false,
          pinned: true,
        },
      ],
    });
    await h.reflector.reflect("a");
    expect(h.store.listProfile().map((row) => row.sourceTurn)).toEqual([
      null,
      null,
    ]);
    await h.turn(
      "b",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "Locker code is 4417" }),
    );
    expect(
      h.store
        .listProfile()
        .map((row) => `${row.key}=${row.value}`)
        .sort(),
    ).toEqual(["name=John", "pronouns=he/him"]);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("still drops a paraphrased locker value that contains the secret", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: false,
      }),
    );
    h.store.upsertProfile({
      key: "gym_locker",
      value: "Gym locker #4417",
      pinned: false,
      shareable: false,
      sourceTurn: null,
      updatedAt: 1,
    });
    const dropped = await h.tool(MEMORY_FORGET_TOOL, {
      text: "locker code is 4417",
    })();
    expect(dropped).toMatchObject({ forgotten: true });
    expect(JSON.stringify(h.store.listProfile())).not.toContain("4417");
    h.runtime.scheduler.stop();
    h.store.close();
  });
});

describe("forget falls back to turns and chunks", () => {
  it("forgets a locker code that was never stored as a fact", async () => {
    const h = setup();
    await h.turn("a", "my locker code is 4417 by the way", "Got it, 4417.");
    await h.turn("a", "what's the weather", "Sunny.");
    const ids = h.store.recentTurns("a", 20).map((row) => row.id);
    h.store.upsertChunk({
      chunkId: "c1",
      sessionId: "a",
      firstTurn: ids[0] ?? null,
      lastTurn: ids.at(-1) ?? null,
      text: "John said his locker code is 4417. Weather sunny.",
    });
    const vector = new Float32Array(EMBEDDING_DIMENSIONS);
    vector[0] = 1;
    await h.vectors.upsert("vec_chunks", "c1", vector);
    const dropped = await h.turn(
      "a",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "my locker code" }),
    );
    expect(dropped).toMatchObject({ forgotten: true, factIds: [] });
    expect(h.store.listChunks().map((chunk) => chunk.chunkId)).not.toContain(
      "c1",
    );
    expect(h.store.forgottenTurnIds()).toEqual(
      expect.arrayContaining([ids[0], ids[1]]),
    );
    expect(h.store.forgottenTurnIds()).not.toContain(ids[2]);
    const hits = JSON.stringify(
      await h.retriever.retrieve("what is my locker code 4417"),
    );
    const next = JSON.stringify(
      await h.log.messagesFor("b", "what is my locker code?"),
    );
    expect(hits).not.toContain("4417");
    expect(next).not.toContain("4417");
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("returns candidates when two turns match and neither is exact", async () => {
    const h = setup();
    await h.turn("a", "my locker code is 1111", "Saved.");
    await h.turn("a", "my locker code is 2222", "Saved.");
    const result = await h.turn(
      "a",
      "please drop one of them",
      "Which?",
      h.tool(MEMORY_FORGET_TOOL, { text: "my locker code" }),
    );
    expect(result).toMatchObject({ forgotten: false, reason: "ambiguous" });
    expect(h.store.forgottenTurnIds()).toEqual([]);
    expect(
      h.store
        .recentTurns("a", 20)
        .map((row) => row.content)
        .join("\n"),
    ).toContain("1111");
    h.runtime.scheduler.stop();
    h.store.close();
  });
});
